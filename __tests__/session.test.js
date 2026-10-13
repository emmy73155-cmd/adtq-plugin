// The driver against the fake ADTQ: discovery, the session prologue, reads,
// writes with read-back, EVENTs, and the failure paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdtq, FAKE_CID } from '../driver/fake/fake-adtq.js';
import { AdtqDevice, discoverAdtq } from '../driver/adtq/device.js';
import { AcnSession } from '../driver/acn/session.js';
import { OBJ, chanAddr } from '../driver/adtq/properties.js';

// the prologue's fixed delays, shortened for tests
const FAST = { advertGapMs: 5, joinDelayMs: 20, writeGateMs: 20, connectTimeoutMs: 3000, requestTimeoutMs: 400 };

async function startFake(t, options) {
  const fake = new FakeAdtq(options);
  await fake.listen();
  t.after(() => fake.stop());
  return fake;
}

const connect = async (t, fake, extra = {}) => {
  const device = new AdtqDevice({
    host: '127.0.0.1',
    slpPort: fake.slpPort,
    multicast: false,
    unicastSlp: true,
    session: FAST,
    ...extra,
  });
  t.after(() => device.close());
  await device.connect();
  return device;
};

test('SLP discovery yields the control port and the CID', async (t) => {
  const fake = await startFake(t);
  const found = await discoverAdtq('127.0.0.1', { slpPort: fake.slpPort, multicast: false, timeoutMs: 500 });
  assert.equal(found.port, fake.controlPort);
  assert.equal(found.cid.toString('hex'), FAKE_CID.toString('hex'));
  assert.equal(found.cidText, 'DD2D453E-0000-11DD-A000-000EDDCCCCCC');
  assert.equal(found.fctn, 'ADTQ');
  assert.equal(found.uacn, 'ADTQ G57 NACLOCK');
});

test('a device that does not answer SLP is a clear error, not a hang', async (t) => {
  const fake = await startFake(t);
  fake.answerSlp = false;
  await assert.rejects(
    () => discoverAdtq('127.0.0.1', { slpPort: fake.slpPort, multicast: false, timeoutMs: 100, attempts: 1 }),
    /No ACN device answered at 127\.0\.0\.1/
  );
});

test('a JOIN with the wrong CID is ignored in silence, as the device does', async (t) => {
  const fake = await startFake(t);
  let ignored = 0;
  fake.on('ignored-join', () => (ignored += 1));
  const session = new AcnSession({
    host: '127.0.0.1',
    port: fake.controlPort,
    deviceCid: Buffer.from('00000000000011dda000000eddcccccc', 'hex'),
    slpPort: fake.slpPort,
    multicast: false,
    unicastSlp: true,
    ...FAST,
    connectTimeoutMs: 300,
  });
  await assert.rejects(() => session.open(), /Could not associate/);
  assert.equal(ignored, 1);
  assert.equal(session.closed, true);
});

test('the session associates and every mapped property reads back decoded', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  assert.equal(device.identity.model, 'ADTQ');
  assert.equal(device.identity.name, 'ADTQ G57 NACLOCK');
  assert.equal(device.session.protoOk, true);
  assert.equal(device.session.recipAssocSent, true);

  const all = await device.readAll();
  assert.equal(all.unanswered, 0);
  assert.deepEqual(all.channels[1], {
    name: 'Channel1',
    groupChannel: { group: 1, channel: 1 },
    frequencyMhz: 470.625,
    muted: false,
    txPowerMode: 'High',
    gainDb: 16,
    audioMode: 'stereo',
    rfStatus: 1,
  });
  assert.equal(all.channels[2].audioMode, 'mono');
  assert.equal(all.channels[3].frequencyMhz, 471.725);
  assert.equal(all.channels[4].txPowerMode, 'Normal');
  assert.deepEqual(all.device, { encryption: 'Off' });
});

test('writes are confirmed by read-back, and a refused write is reported as not applied', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);

  assert.deepEqual(await device.setMute(2, true), { ok: true, value: true });
  assert.equal(fake.muted(2), true);
  assert.deepEqual(await device.setMute(2, false), { ok: true, value: false });

  const freq = await device.setFrequencyMhz(3, 500.1);
  assert.deepEqual(freq, { ok: true, requestedMhz: 500.1, value: 500.1 });
  assert.equal(fake.frequencyKhz(3), 500100);
  // off-raster is quantised before it is sent
  assert.equal((await device.setFrequencyMhz(3, 500.113)).value, 500.125);
  // outside the band: the device ignores it and the read-back says so
  const outside = await device.setFrequencyMhz(3, 700);
  assert.equal(outside.ok, false);
  assert.equal(outside.value, 500.125);

  assert.deepEqual(await device.setTxPowerMode(1, 'low'), { ok: true, value: 'Low' });
  assert.deepEqual(await device.setAudioMode(2, 'Stereo'), { ok: true, value: 'stereo' });
  assert.deepEqual(await device.setChannelName(4, 'Lead Vox'), { ok: true, value: 'Lead Vox' });
  assert.equal(fake.channelName(4), 'Lead Vox');

  fake.rejectWrites = true;
  assert.deepEqual(await device.setMute(1, true), { ok: false, value: false });
});

test('a change made elsewhere arrives as an EVENT on the change feed', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  const changes = [];
  device.on('change', (c) => changes.push(c));
  // the front panel mutes channel 3
  fake.setRaw(chanAddr(3, OBJ.RF_MUTE), Buffer.from([1]));
  fake.setRaw(chanAddr(1, OBJ.FREQ_KHZ), Buffer.from([0, 0x07, 0x2e, 0x61]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(changes, [
    { channel: 3, key: 'muted', value: true },
    { channel: 1, key: 'frequencyMhz', value: 470.625 },
  ]);
});

test('lost datagrams are retried, and a device that stops answering times out cleanly', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  fake.dropInbound = 0.3;
  const all = await device.readChannels([1, 2]);
  // two attempts at 30% loss leave almost everything answered; what is not is counted
  assert.ok(all.unanswered <= 4, `${all.unanswered} unanswered`);
  fake.dropInbound = 0;

  fake.silent = true;
  const gone = await device.readChannels([1]);
  assert.equal(gone.unanswered, gone.asked);
  assert.equal(await device.session.get(chanAddr(1, OBJ.RF_MUTE), 100), null);
});

test('closing sends the disconnect sequence and the fake forgets the session', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  assert.equal(fake.sessions.size, 1);
  const left = new Promise((r) => fake.once('left', r));
  await device.close();
  await left;
  assert.equal(fake.sessions.size, 0);
});
