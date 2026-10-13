// The Shure ADTQ as a SoundBase monitored device: discovery over SLP, one
// held-open ACN session per unit, every mapped property pushed as state, and
// the writable ones exposed through PropertyControl. Everything about the
// wire lives in driver/; this file maps the device onto the contract.
//
//   discoverDevices          a standing SLP browse of the segment (plus any
//                            addresses the plugin config lists)
//   createMonitoringAdapter  open -> connect, read everything, report it,
//                            then refresh on a timer and on device EVENTs;
//                            setProperty -> write, read back, report what
//                            the device now holds

import { HttpError } from '@soundbase/plugin-shell';
import { AdtqDevice } from './driver/adtq/device.js';
import {
  AUDIO_MODES,
  CHANNEL_COUNT,
  CHANNEL_NAME_MAX,
  FREQ_MAX_KHZ,
  FREQ_MIN_KHZ,
  FREQ_RASTER_KHZ,
  TX_POWER_MODES,
} from './driver/adtq/properties.js';
import { SLP_PORT, SlpBrowser } from './driver/acn/slp.js';
import { FakeAdtq } from './driver/fake/fake-adtq.js';
import { isIpv4, parseAddressList } from './driver/netutil.js';

export const PRODUCT = 'plugin:shure-adtq/adtq';
export const TX_POWER_KEY = 'x.shure-adtq.txPowerMode';
export const NET_ID_PREFIX = 'net:';
export const SIM_DEVICE_ID = 'sim:adtq';

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 30000;
// how long the SLP browse keeps running after the shell last asked
const BROWSE_IDLE_MS = 90_000;
// the fake needs none of Workbench's advert-to-JOIN pause
const SIMULATED_SESSION = { advertGapMs: 5, joinDelayMs: 50, writeGateMs: 50, connectTimeoutMs: 5000, requestTimeoutMs: 150 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const log = (level, message) => {
  process.stderr.write(`[shure-adtq] [${level}] ${message}\n`);
};

const env = (name) => process.env[name];
const envSlpPort = () => {
  const n = Number(env('SB_ADTQ_SLP_PORT'));
  return Number.isInteger(n) && n > 0 ? n : SLP_PORT;
};

// ---------------------------------------------------------------------------
// the simulator: a fake ADTQ on loopback, started on demand
// ---------------------------------------------------------------------------

let simulator = null;
let simulatorStarting = null;

const simulateWanted = (pluginConfig) =>
  pluginConfig?.simulate === true || env('SB_ADTQ_SIMULATE') === '1';

/** The running fake, for tests and the smoke check; null until simulation is on. */
export function getSimulator() {
  return simulator;
}

async function ensureSimulator() {
  if (simulator) return simulator;
  if (!simulatorStarting) {
    simulatorStarting = (async () => {
      const fake = new FakeAdtq({ uacn: 'ADTQ (simulated)' });
      await fake.listen();
      log('info', `simulated ADTQ listening on 127.0.0.1 (SLP ${fake.slpPort}, control ${fake.controlPort})`);
      simulator = fake;
      return fake;
    })().finally(() => {
      simulatorStarting = null;
    });
  }
  return simulatorStarting;
}

async function stopSimulator() {
  const fake = simulator;
  simulator = null;
  if (fake) await fake.stop();
}

const simulatedDevice = (fake) => ({
  id: SIM_DEVICE_ID,
  name: 'ADTQ (simulated)',
  product: PRODUCT,
  transport: { kind: 'simulated', host: '127.0.0.1', port: fake.controlPort },
  config: { host: '127.0.0.1', slpPort: fake.slpPort, simulated: true },
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let browser = null;
let lastDiscoverAt = 0;

const isAdtq = (reply) => /^adtq$/i.test(reply.fctn ?? '');

function ensureBrowser(pluginConfig) {
  const targets = parseAddressList(pluginConfig?.addresses);
  if (!browser) {
    browser = new SlpBrowser({
      targets,
      multicast: env('SB_ADTQ_NO_MULTICAST') !== '1',
      port: envSlpPort(),
      log,
      filter: isAdtq,
    });
    browser.on('found', (r) => log('info', `found ${r.fctn} "${r.uacn}" at ${r.ip}:${r.port} (${r.cidText})`));
    browser.on('lost', (r) => log('info', `lost ${r.fctn} "${r.uacn}" at ${r.ip}`));
  } else {
    browser.setTargets(targets);
  }
  browser.start();
  return browser;
}

const idleCheck = () => {
  if (browser && Date.now() - lastDiscoverAt > BROWSE_IDLE_MS) browser.stop();
};

export const discoveredDevice = (reply) => ({
  id: `${NET_ID_PREFIX}${reply.ip}`,
  name: reply.uacn ? `${reply.uacn} (${reply.ip})` : `ADTQ (${reply.ip})`,
  product: PRODUCT,
  transport: { kind: 'network', host: reply.ip, port: reply.port },
  config: { host: reply.ip },
});

/**
 * What the SLP browse has heard from lately. Returns at once: the browse runs
 * in the background at its own cadence, and this is polled once a second.
 */
export async function discoverDevices(pluginConfig = {}) {
  lastDiscoverAt = Date.now();
  const found = [];
  if (simulateWanted(pluginConfig)) {
    found.push(simulatedDevice(await ensureSimulator()));
  } else if (simulator) {
    await stopSimulator();
  }
  if (env('SB_ADTQ_NO_DISCOVERY') === '1') return found;
  const b = ensureBrowser(pluginConfig);
  setTimeout(idleCheck, BROWSE_IDLE_MS + 1000).unref?.();
  for (const reply of b.devices()) found.push(discoveredDevice(reply));
  return found;
}

/** Stops the background browse and the simulator (for tests and shutdown). */
export async function shutdownDiscovery() {
  browser?.stop();
  browser = null;
  await stopSimulator();
}

// ---------------------------------------------------------------------------
// the monitoring adapter
// ---------------------------------------------------------------------------

/** The unit's address: `device.config.host`, else the `net:<ip>` id. */
export function resolveHost(device) {
  const configured = device?.config?.host;
  if (typeof configured === 'string' && configured.trim()) {
    const host = configured.trim();
    if (!isIpv4(host)) throw new Error(`"${host}" is not an IPv4 address; the ADTQ is addressed by IP`);
    return host;
  }
  const id = typeof device?.id === 'string' ? device.id : '';
  if (id.startsWith(NET_ID_PREFIX) && isIpv4(id.slice(NET_ID_PREFIX.length))) return id.slice(NET_ID_PREFIX.length);
  throw new Error('an ADTQ needs an IP address (the "IP address" field)');
}

const propertyDescriptors = () => {
  const channel = (id, value, extra = {}) => ({
    id,
    scope: 'channel',
    access: 'readWrite',
    stateBinding: { key: id },
    value,
    ...extra,
  });
  return [
    channel('mute', { type: 'boolean' }),
    channel('txPowerMode', { type: 'enum', options: [...TX_POWER_MODES] }, { stateBinding: { key: TX_POWER_KEY } }),
    channel('audioMode', { type: 'enum', options: [...AUDIO_MODES] }, { stateBinding: { key: 'audioModes', path: ['txMode'] } }),
    channel('frequency', {
      type: 'number',
      min: FREQ_MIN_KHZ / 1000,
      max: FREQ_MAX_KHZ / 1000,
      step: FREQ_RASTER_KHZ / 1000,
      unit: 'MHz',
    }),
    channel('channelName', { type: 'string', maxLength: CHANNEL_NAME_MAX }),
    // read-only by design: raising gain raises the level in someone's ears,
    // and encryption is a device-wide setting that forces every receiver to
    // re-sync. Both are shown; both are changed in Workbench.
    { ...channel('gain', { type: 'number', unit: 'dB' }), access: 'readOnly' },
    {
      id: 'rfEncryption',
      scope: 'device',
      access: 'readOnly',
      stateBinding: { key: 'rfEncryption', path: ['enabled'] },
      value: { type: 'boolean' },
    },
  ];
};

const badValue = (propertyId, expected) =>
  new HttpError(400, 'bad_value', `${propertyId} expects ${expected}`);

class AdtqMonitoringAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.host = null;
    this.hostError = null;
    // the simulated unit is addressed by its id alone, so a host that re-adds
    // it with an empty config (as it does for any discovered device) still
    // lands on the fake rather than on a real SLP port
    this.simulated = device?.id === SIM_DEVICE_ID || device?.config?.simulated === true;
    if (this.simulated) {
      this.host = '127.0.0.1';
    } else {
      try {
        this.host = resolveHost(device);
      } catch (err) {
        this.hostError = err;
      }
    }
    this.slpPort = Number.isInteger(device?.config?.slpPort) ? device.config.slpPort : envSlpPort();
    const poll = Number(pluginConfig.pollIntervalMs);
    this.pollIntervalMs = isNum(poll) ? clamp(poll, MIN_POLL_MS, MAX_POLL_MS) : DEFAULT_POLL_MS;
    this.unit = null;
    this.identity = null;
    this.state = { channels: {}, device: {} };
    this.pollTimer = null;
    this.polling = null;
    this.closed = false;
    this.lastRefreshAt = 0;
    // assigned by the shell before open()
    this.onState = null;
    this.onWarnings = null;
    this.onFatal = null;
  }

  log(level, message) {
    log(level, `[${this.device.id}] ${message}`);
  }

  async open() {
    if (this.hostError) throw this.hostError;
    if (this.simulated) this.slpPort = (await ensureSimulator()).slpPort;
    const unit = new AdtqDevice({
      host: this.host,
      slpPort: this.slpPort,
      multicast: !this.simulated && env('SB_ADTQ_NO_MULTICAST') !== '1',
      unicastSlp: this.simulated,
      session: this.simulated ? SIMULATED_SESSION : {},
      log: (level, message) => this.log(level, message),
    });
    unit.on('change', (change) => this.applyChange(change));
    unit.on('dropped', () => this.fatal(new Error(`the control session with the ADTQ at ${this.host} dropped`)));
    unit.on('leaving', () => this.fatal(new Error(`the ADTQ at ${this.host} left the session`)));
    unit.on('error', (err) => this.log('warn', `session: ${err?.message || err}`));
    this.unit = unit;
    this.identity = await unit.connect();
    if (this.closed) {
      await unit.close();
      throw new Error('closed while connecting');
    }
    this.onState?.('deviceName', this.identity.name ?? this.identity.model ?? 'ADTQ');
    this.onState?.('connection', { connected: true, since: new Date().toISOString() });
    await this.refresh({ initial: true });
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), this.pollIntervalMs);
    this.pollTimer.unref?.();
    return {
      channelCount: CHANNEL_COUNT,
      properties: propertyDescriptors(),
      identity: { model: this.identity.model ?? 'ADTQ', firmware: null },
    };
  }

  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const unit = this.unit;
    this.unit = null;
    if (unit) await unit.close();
  }

  fatal(err) {
    if (this.closed) return;
    this.log('error', err.message);
    this.onFatal?.(err);
  }

  // -- state --------------------------------------------------------------------------------

  /** Re-reads every channel and the device; reports what changed. */
  async refresh({ initial = false } = {}) {
    if (this.polling) return this.polling;
    if (!this.unit?.connected) return null;
    this.polling = (async () => {
      const all = await this.unit.readAll();
      if (this.closed) return;
      if (all.unanswered === all.asked) {
        // nothing at all came back: one more cheap probe, then call it dead
        const probe = await this.unit.readChannels([1]);
        if (probe.unanswered === probe.asked) {
          this.fatal(new Error(`the ADTQ at ${this.host} stopped answering`));
          return;
        }
      }
      this.lastRefreshAt = Date.now();
      for (const [n, props] of Object.entries(all.channels)) this.mergeChannel(Number(n), props);
      if (all.device.encryption !== null) this.state.device.encryption = all.device.encryption;
      this.emitAll();
      const warnings = [];
      if (all.unanswered > 0) {
        warnings.push({
          id: 'unanswered-reads',
          severity: all.unanswered > all.asked / 4 ? 'warning' : 'info',
          message:
            `${all.unanswered} of ${all.asked} property reads went unanswered on the last refresh. ` +
            'The network between this machine and the ADTQ is dropping packets; values shown may be stale.',
        });
      }
      this.onWarnings?.(warnings);
      if (initial) this.log('info', `${this.identity.name ?? this.host}: ${all.asked - all.unanswered}/${all.asked} properties read`);
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  mergeChannel(n, props) {
    const ch = (this.state.channels[n] ??= {});
    for (const [key, value] of Object.entries(props)) if (value !== null) ch[key] = value;
  }

  /** An EVENT the unit pushed: someone changed it on the panel or in Workbench. */
  applyChange({ channel, key, value }) {
    if (this.closed) return;
    if (channel === null) {
      if (key === 'encryption') this.state.device.encryption = value;
    } else {
      this.mergeChannel(channel, { [key]: value });
    }
    this.emitAll();
  }

  channelMap(pick) {
    const channels = {};
    for (const [n, ch] of Object.entries(this.state.channels)) {
      const v = pick(ch);
      if (v !== undefined && v !== null) channels[n] = v;
    }
    return { channels };
  }

  /** Every key, from the cache; the shell drops the ones that did not change. */
  emitAll() {
    const emit = (key, value) => this.onState?.(key, value);
    emit('channelName', this.channelMap((ch) => ch.name));
    emit('frequency', this.channelMap((ch) => ch.frequencyMhz));
    emit('groupChannel', this.channelMap((ch) => ch.groupChannel));
    emit('mute', this.channelMap((ch) => ch.muted));
    emit('rfState', this.channelMap((ch) => (typeof ch.muted === 'boolean' ? !ch.muted : undefined)));
    emit('gain', this.channelMap((ch) => ch.gainDb));
    emit('audioModes', this.channelMap((ch) => (ch.audioMode ? { txMode: ch.audioMode } : undefined)));
    emit(TX_POWER_KEY, this.channelMap((ch) => ch.txPowerMode));
    const enc = this.state.device.encryption;
    if (enc) emit('rfEncryption', { mode: enc, enabled: enc === 'On' });
  }

  // -- PropertyControl ------------------------------------------------------------------------

  async setProperty({ propertyId, channelIndex, value }) {
    const unit = this.unit;
    if (!unit?.connected)
      throw new HttpError(503, 'device_unavailable', `no live session with the ADTQ at ${this.host}`);
    const perChannel = ['mute', 'txPowerMode', 'audioMode', 'frequency', 'channelName'];
    if (perChannel.includes(propertyId)) {
      if (!Number.isInteger(channelIndex) || channelIndex < 1 || channelIndex > CHANNEL_COUNT) {
        throw new HttpError(400, 'unknown_channel', `${propertyId} is per channel; channelIndex must be 1..${CHANNEL_COUNT}`);
      }
    }
    let result;
    let key;
    switch (propertyId) {
      case 'mute':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        result = await unit.setMute(channelIndex, value);
        key = 'muted';
        break;
      case 'txPowerMode':
        if (typeof value !== 'string' || !TX_POWER_MODES.some((m) => m.toLowerCase() === value.toLowerCase()))
          throw badValue(propertyId, `one of ${TX_POWER_MODES.join(', ')}`);
        result = await unit.setTxPowerMode(channelIndex, value);
        key = 'txPowerMode';
        break;
      case 'audioMode':
        if (typeof value !== 'string' || !AUDIO_MODES.some((m) => m === value.toLowerCase().split(/\s+/)[0]))
          throw badValue(propertyId, `one of ${AUDIO_MODES.join(', ')}`);
        result = await unit.setAudioMode(channelIndex, value);
        key = 'audioMode';
        break;
      case 'frequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in MHz');
        result = await unit.setFrequencyMhz(channelIndex, value);
        key = 'frequencyMhz';
        break;
      case 'channelName':
        if (typeof value !== 'string') throw badValue(propertyId, 'a string');
        result = await unit.setChannelName(channelIndex, value);
        key = 'name';
        break;
      case 'gain':
      case 'rfEncryption':
        throw new HttpError(400, 'read_only', `${propertyId} is read-only in this plugin; change it in Wireless Workbench`);
      default:
        throw new HttpError(400, 'unknown_property', `No property ${propertyId} on ${PRODUCT}`);
    }
    if (result.value === null) {
      this.log('warn', `${propertyId} on channel ${channelIndex}: no read-back from the unit; state unconfirmed`);
      return;
    }
    if (!result.ok) {
      this.log('warn', `${propertyId} on channel ${channelIndex}: the unit did not take ${JSON.stringify(value)}; it reads ${JSON.stringify(result.value)}`);
    }
    // the device is the truth: report what it holds, whether or not that is what was asked
    this.mergeChannel(channelIndex, { [key]: result.value });
    this.emitAll();
  }
}

export function createMonitoringAdapter(device, pluginConfig) {
  return new AdtqMonitoringAdapter(device, pluginConfig);
}
