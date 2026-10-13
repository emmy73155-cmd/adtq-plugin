// The ADTQ as a device: discovery by SLP, one held-open ACN session, typed
// accessors for the mapped properties, and a change feed. Everything the
// adapter needs and nothing about SoundBase.

import { EventEmitter } from 'node:events';
import { AcnSession } from '../acn/session.js';
import { DMP } from '../acn/pdu.js';
import { SLP_PORT, slpDiscover } from '../acn/slp.js';
import {
  CHANNEL_COUNT,
  CHANNEL_NAME_MAX,
  CHANNEL_PROPS,
  DEVICE_PROPS,
  OBJ,
  audioModeIndex,
  audioModeLabel,
  chanAddr,
  clampKhz,
  decodeProp,
  decodeString,
  encodeString,
  encodeU32,
  encodeU8,
  khzToMhz,
  mhzToKhz,
  quantizeKhz,
  txPowerIndex,
  txPowerLabel,
} from './properties.js';

const noop = () => {};

/**
 * Finds the ADTQ at `host`: its control port and — mandatory — its CID.
 * Returns `{ port, cid, cidText, fctn, uacn }`.
 *
 * The request goes to the SLP multicast group as well as straight to the
 * unit: a real ADTQ answers the multicast request and ignores the unicast
 * one, so asking only the unit itself hears nothing (`multicast: false` is
 * for a fake on loopback). The reply is picked out by the unit's address.
 */
export async function discoverAdtq(host, { slpPort = SLP_PORT, multicast = true, attempts = 2, timeoutMs = 3000, log = noop } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const replies = await slpDiscover({ targets: [host], multicast, port: slpPort, timeoutMs, log });
    const reply = replies.find((r) => r.from === host || r.ip === host);
    if (reply) {
      last = reply;
      if (reply.cid) break;
    }
  }
  if (!last) {
    throw new Error(
      `No ACN device answered at ${host}. Check that the ADTQ is powered, on this network, and ` +
        `that UDP/${slpPort} is not blocked between this machine and the device.`
    );
  }
  if (!last.cid) {
    throw new Error(
      `${host} answered but did not advertise its CID. Without the device's real CID a session ` +
        'request is silently ignored, so nothing can be controlled. Check for a firewall on UDP/8427.'
    );
  }
  return last;
}

export class AdtqDevice extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.slpPort=8427]
   * @param {boolean} [options.multicast=true]
   * @param {boolean} [options.unicastSlp=false]
   * @param {object} [options.session] extra AcnSession options (timing overrides)
   * @param {(level: string, msg: string) => void} [options.log]
   */
  constructor({ host, slpPort = SLP_PORT, multicast = true, unicastSlp = false, session = {}, log = noop }) {
    super();
    this.host = host;
    this.slpPort = slpPort;
    this.multicast = multicast;
    this.unicastSlp = unicastSlp;
    this.sessionOptions = session;
    this.log = log;
    this.identity = null;
    this.session = null;
    this.closed = false;
  }

  get connected() {
    return Boolean(this.session?.ready) && !this.closed;
  }

  /** SLP discovery, then the session prologue. Resolves with the identity. */
  async connect() {
    if (this.session) throw new Error('already connected');
    const found = await discoverAdtq(this.host, { slpPort: this.slpPort, multicast: this.multicast, log: this.log });
    this.identity = {
      host: this.host,
      port: found.port,
      cid: found.cid,
      cidText: found.cidText,
      model: found.fctn,
      name: found.uacn,
    };
    this.log('info', `${this.host}: ${found.fctn ?? '?'} "${found.uacn ?? '?'}" port ${found.port} cid ${found.cidText}`);
    const session = new AcnSession({
      host: this.host,
      port: found.port,
      deviceCid: found.cid,
      slpPort: this.slpPort,
      multicast: this.multicast,
      unicastSlp: this.unicastSlp,
      log: this.log,
      ...this.sessionOptions,
    });
    session.on('dmp', (prop) => {
      if (prop.vector !== DMP.EVENT) return;
      const decoded = decodeProp(prop.addr, prop.value);
      if (decoded && decoded.value !== null) this.emit('change', decoded);
    });
    session.on('leaving', () => this.emit('leaving'));
    session.on('close', () => {
      if (!this.closed) this.emit('dropped');
    });
    session.on('error', (err) => this.emit('error', err));
    this.session = session;
    await session.open();
    return this.identity;
  }

  async close() {
    this.closed = true;
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  requireSession() {
    if (!this.session?.ready) throw new Error(`no live session with ${this.host}`);
    return this.session;
  }

  // -- reads ---------------------------------------------------------------------------

  /** Every mapped property of one channel; a null field means no answer. */
  async readChannel(channel) {
    const all = await this.readChannels([channel]);
    return all.channels[channel];
  }

  /**
   * All mapped properties of the given channels in one pass.
   * Returns `{ channels: { n: {...} }, unanswered: number, asked: number }`.
   */
  async readChannels(channels = [1, 2, 3, 4]) {
    const session = this.requireSession();
    const addrs = [];
    const plan = new Map();
    for (const ch of channels) {
      for (const prop of CHANNEL_PROPS) {
        const addr = chanAddr(ch, prop.obj);
        addrs.push(addr);
        plan.set(addr, { ch, prop });
      }
    }
    const { replies, unanswered } = await session.getMany(addrs);
    const out = {};
    for (const ch of channels) {
      out[ch] = Object.fromEntries(CHANNEL_PROPS.map((p) => [p.key, null]));
    }
    for (const [addr, reply] of replies) {
      const { ch, prop } = plan.get(addr);
      if (reply.vector === DMP.GET_REPLY) out[ch][prop.key] = prop.decode(reply.value);
    }
    return { channels: out, unanswered: unanswered.length, asked: addrs.length };
  }

  /** Device-wide properties: `{ encryption }`. */
  async readDevice() {
    const session = this.requireSession();
    const out = {};
    for (const prop of DEVICE_PROPS) {
      const reply = await session.get(chanAddr(prop.channel, prop.obj));
      out[prop.key] = reply && reply.vector === DMP.GET_REPLY ? prop.decode(reply.value) : null;
    }
    return out;
  }

  async readAll() {
    const channels = await this.readChannels([1, 2, 3, 4]);
    const device = await this.readDevice();
    return { ...channels, device };
  }

  // -- writes ---------------------------------------------------------------------------
  // Every setter writes, reads back, and reports what the device now holds.
  // `ok` is false when the device did not take the value; `value` is the
  // decoded read-back (null when nothing came back at all).

  async setMute(channel, muted) {
    const session = this.requireSession();
    const r = await session.set(chanAddr(channel, OBJ.RF_MUTE), encodeU8(muted ? 1 : 0));
    return { ok: r.ok, value: r.after && r.after.length === 1 ? r.after[0] === 1 : null };
  }

  /** Frequency in MHz, quantised to the 25 kHz raster and clamped to UHF. */
  async setFrequencyMhz(channel, mhz) {
    const session = this.requireSession();
    const khz = clampKhz(quantizeKhz(mhzToKhz(mhz)));
    const r = await session.set(chanAddr(channel, OBJ.FREQ_KHZ), encodeU32(khz));
    return {
      ok: r.ok,
      requestedMhz: khzToMhz(khz),
      value: r.after && r.after.length === 4 ? khzToMhz(r.after.readUInt32BE(0)) : null,
    };
  }

  async setTxPowerMode(channel, mode) {
    const session = this.requireSession();
    const idx = typeof mode === 'number' ? mode : txPowerIndex(mode);
    if (idx === null || idx === undefined) throw new RangeError(`unknown TX power mode ${mode}`);
    const r = await session.set(chanAddr(channel, OBJ.TX_POWER), encodeU8(idx));
    return { ok: r.ok, value: r.after && r.after.length === 1 ? txPowerLabel(r.after[0]) : null };
  }

  async setAudioMode(channel, mode) {
    const session = this.requireSession();
    const idx = typeof mode === 'number' ? mode : audioModeIndex(mode);
    if (idx === null || idx === undefined) throw new RangeError(`unknown audio mode ${mode}`);
    const r = await session.set(chanAddr(channel, OBJ.AUDIO_MODE), encodeU8(idx));
    return { ok: r.ok, value: r.after && r.after.length === 1 ? audioModeLabel(r.after[0]) : null };
  }

  async setChannelName(channel, name) {
    const session = this.requireSession();
    const clean = String(name).replace(/[^\x20-\x7e]/g, '').slice(0, CHANNEL_NAME_MAX);
    const r = await session.set(chanAddr(channel, OBJ.CHAN_NAME), encodeString(clean));
    return { ok: r.ok, value: r.after ? decodeString(r.after) : null };
  }
}

export { CHANNEL_COUNT };
