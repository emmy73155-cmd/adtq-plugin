// The ADTQ's DMP property map — what is known about the device's address
// space, and the evidence grade of each entry. Everything here comes from the
// enumeration and watch work recorded in the research notes
// (ADTQ Mute/adtq_properties.md); nothing is inferred from value shape alone.
//
// Address structure:
//
//   0x02 <CH> <OBJ_HI> <OBJ_LO>
//     byte 0     0x02       device class
//     byte 1     0x00-0x03  channel index (0 = CH1 … 3 = CH4)
//     bytes 2-3  object + property index
//
// Value encodings: integers big-endian (signed where noted), strings as a
// 2-byte big-endian TOTAL length (header included) followed by ASCII.

export const CHANNEL_COUNT = 4;
export const DEVICE_CLASS = 0x02;

/** Object indices within a channel. `confirmed` means round-tripped or diffed live. */
export const OBJ = Object.freeze({
  CHAN_NAME_ALT: 0x0001, // confirmed mirror of CHAN_NAME
  AUDIO_GAIN_DB: 0x0102, // confirmed: signed byte, value is dB
  AUDIO_MODE: 0x0613, // confirmed: 01 stereo, 00 mono (summed)
  GROUP_CHAN: 0x0802, // confirmed: string "group,channel"
  FREQ_KHZ: 0x0804, // confirmed: 4-byte kHz
  RF_MUTE: 0x080e, // confirmed: 01 muted, 00 unmuted (SET round-tripped)
  TX_POWER: 0x0811, // confirmed enum: 00 Normal, 01 High, 02 Low (identifiers, not a scale)
  POWER_LEVEL: 0x0814, // confirmed: 20 on High, 10 on Normal AND Low
  RF_STATUS: 0x081f, // probable: reads 01 while unmuted; NOT a mute mirror
  CHAN_NAME: 0x08fb, // confirmed: string
  MODEL: 0x1000, // probable: string "ADXR-A"
  ENCRYPTION: 0x2000, // confirmed: 00 off, 03 on; device-wide (all channels read alike)
});

/** Probable live RF readings (dBm, signed 4-byte); they drift every read. Not exposed. */
export const OBJ_RF_LEVELS = Object.freeze([0x0117, 0x0118, 0x0119, 0x011a, 0x01d3, 0x01d4]);

export const TX_POWER_MODES = Object.freeze(['Normal', 'High', 'Low']);
const TX_POWER_BY_INDEX = Object.freeze({ 0: 'Normal', 1: 'High', 2: 'Low' });
const TX_POWER_INDEX = Object.freeze({ normal: 0, high: 1, low: 2 });

export const AUDIO_MODES = Object.freeze(['stereo', 'mono']);
const AUDIO_MODE_BY_INDEX = Object.freeze({ 1: 'stereo', 0: 'mono' });
const AUDIO_MODE_INDEX = Object.freeze({ stereo: 1, mono: 0 });

const ENCRYPTION_BY_INDEX = Object.freeze({ 0: 'Off', 3: 'On' });

export const FREQ_RASTER_KHZ = 25;
// the UHF sanity range the reference tool guards with; the band limits of a
// particular ADTQ are not readable over DMP, and the device refuses a
// frequency outside its band (the read-back then shows it unchanged)
export const FREQ_MIN_KHZ = 400_000;
export const FREQ_MAX_KHZ = 1_000_000;
export const CHANNEL_NAME_MAX = 8;

export function chanAddr(channel, obj) {
  if (!Number.isInteger(channel) || channel < 1 || channel > CHANNEL_COUNT)
    throw new RangeError(`channel must be 1..${CHANNEL_COUNT} (got ${channel})`);
  return ((DEVICE_CLASS << 24) | ((channel - 1) << 16) | obj) >>> 0;
}

/** `{ channel, obj }` of an address in this device class, or null. */
export function splitAddr(addr) {
  if ((addr >>> 24) !== DEVICE_CLASS) return null;
  const ch = ((addr >>> 16) & 0xff) + 1;
  if (ch < 1 || ch > CHANNEL_COUNT) return null;
  return { channel: ch, obj: addr & 0xffff };
}

/** Shure string: 2-byte big-endian TOTAL length (header included), then ASCII. */
export function decodeString(v) {
  if (!v || v.length < 2) return null;
  if (v.readUInt16BE(0) !== v.length) return null;
  const body = v.subarray(2);
  for (const b of body) if (b < 0x20 || b > 0x7e) return null;
  return body.toString('ascii');
}

export function encodeString(s) {
  const body = Buffer.from(String(s), 'ascii');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(out.length, 0);
  body.copy(out, 2);
  return out;
}

export function decodeInt(v, signed = false) {
  if (!v || !v.length || v.length > 6) return null;
  return signed ? v.readIntBE(0, v.length) : v.readUIntBE(0, v.length);
}

export const encodeU8 = (n) => Buffer.from([n & 0xff]);
export const encodeI8 = (n) => Buffer.from([n & 0xff]);
export const encodeU32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export const txPowerLabel = (raw) => TX_POWER_BY_INDEX[raw] ?? null;
export const txPowerIndex = (label) => TX_POWER_INDEX[String(label).trim().toLowerCase()] ?? null;
export const audioModeLabel = (raw) => AUDIO_MODE_BY_INDEX[raw] ?? null;
export const audioModeIndex = (label) => AUDIO_MODE_INDEX[String(label).trim().toLowerCase().split(/\s+/)[0]] ?? null;
export const encryptionLabel = (raw) => ENCRYPTION_BY_INDEX[raw] ?? null;

export const khzToMhz = (khz) => Math.round(khz) / 1000;
export const mhzToKhz = (mhz) => Math.round(mhz * 1000);
export const quantizeKhz = (khz) => Math.round(khz / FREQ_RASTER_KHZ) * FREQ_RASTER_KHZ;
export const clampKhz = (khz) => Math.min(FREQ_MAX_KHZ, Math.max(FREQ_MIN_KHZ, khz));

/** "1,3" -> { group: 1, channel: 3 } */
export function parseGroupChannel(s) {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(s ?? '');
  return m ? { group: Number(m[1]), channel: Number(m[2]) } : null;
}

/** The per-channel objects the plugin reads, with how each decodes. */
export const CHANNEL_PROPS = Object.freeze([
  { key: 'name', obj: OBJ.CHAN_NAME, decode: decodeString },
  { key: 'groupChannel', obj: OBJ.GROUP_CHAN, decode: (v) => parseGroupChannel(decodeString(v)) },
  { key: 'frequencyMhz', obj: OBJ.FREQ_KHZ, decode: (v) => (v.length === 4 ? khzToMhz(decodeInt(v)) : null) },
  { key: 'muted', obj: OBJ.RF_MUTE, decode: (v) => (v.length === 1 ? v[0] === 1 : null) },
  { key: 'txPowerMode', obj: OBJ.TX_POWER, decode: (v) => txPowerLabel(decodeInt(v)) },
  { key: 'gainDb', obj: OBJ.AUDIO_GAIN_DB, decode: (v) => (v.length === 1 ? decodeInt(v, true) : null) },
  { key: 'audioMode', obj: OBJ.AUDIO_MODE, decode: (v) => audioModeLabel(decodeInt(v)) },
  { key: 'rfStatus', obj: OBJ.RF_STATUS, decode: (v) => decodeInt(v) },
]);

export const DEVICE_PROPS = Object.freeze([
  { key: 'encryption', obj: OBJ.ENCRYPTION, channel: 1, decode: (v) => encryptionLabel(decodeInt(v)) },
]);

const CHANNEL_PROP_BY_OBJ = new Map(CHANNEL_PROPS.map((p) => [p.obj, p]));

/**
 * Decodes one property PDU's address and value into `{ channel, key, value }`
 * — null for an address the plugin does not model. Used both for read-backs
 * and for the EVENTs the device pushes when something changes.
 */
export function decodeProp(addr, value) {
  const split = splitAddr(addr);
  if (!split) return null;
  const prop = CHANNEL_PROP_BY_OBJ.get(split.obj);
  if (prop) return { channel: split.channel, key: prop.key, value: prop.decode(value) };
  if (split.obj === OBJ.ENCRYPTION)
    return { channel: null, key: 'encryption', value: encryptionLabel(decodeInt(value)) };
  return null;
}
