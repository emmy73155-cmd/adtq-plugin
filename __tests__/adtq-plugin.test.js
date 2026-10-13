// Contract tests for the adapter, driven through the real shell over real
// HTTP, against the simulated ADTQ — which speaks the device's actual wire
// protocol on loopback, so the whole stack is under test: shell, adapter,
// driver, sockets, session, crypto.
//
// Nothing here hardcodes the plugin's id: everything that could change under
// `npm run rename` is read from soundbase-plugin.json.

process.env.SB_ADTQ_SIMULATE = '1';
// no SLP multicast on the test machine's real network
process.env.SB_ADTQ_NO_DISCOVERY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX, SSE_EVENTS } from '@soundbase/plugin-contract';
import { PRODUCT, SIM_DEVICE_ID, TX_POWER_KEY, getSimulator, shutdownDiscovery } from '../adapter.js';
import { OBJ, chanAddr } from '../driver/adtq/properties.js';

const manifest = JSON.parse(readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8'));
const DEVICE_PATH = `/devices/${encodeURIComponent(SIM_DEVICE_ID)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function openEvents() {
  const controller = new AbortController();
  const res = await fetch(`${handle.url}/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const records = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          records.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted by the test
    }
  })();
  return { records, close: () => controller.abort() };
}

const stateFor = (records, key) =>
  records
    .filter((r) => r.event === SSE_EVENTS.DEVICE_STATE && r.data.deviceId === SIM_DEVICE_ID)
    .flatMap((r) => r.data.patches)
    .filter((p) => p.key === key);

const waitFor = async (predicate, timeoutMs = 4000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await predicate();
    if (hit) return hit;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const deviceRow = async () => (await request('GET', '/devices')).body.devices.find((d) => d.id === SIM_DEVICE_ID);

test.after(async () => {
  await handle.close();
  await shutdownDiscovery();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `adapter.js announces ${PRODUCT}; the manifest declares ${declared.join(', ')}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
  assert.ok(manifest.stateKeys.some((k) => k?.key === TX_POWER_KEY), 'the extension key is declared');
});

test('the simulated unit is discovered, then owned and opened by the host', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  const found = await waitFor(deviceRow, 3000, 'discovery');
  assert.equal(found.product, PRODUCT);
  assert.equal(found.discovered, true);
  assert.equal(found.channelCount, undefined, 'closed until owned');

  // the host re-adds a discovered device with only what its config form holds
  const added = await request('POST', '/devices', { id: SIM_DEVICE_ID, product: PRODUCT, config: {} });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added.body));

  const device = await waitFor(async () => {
    const row = await deviceRow();
    return row?.status.status === 'ok' ? row : null;
  }, 8000, 'the device to open');
  assert.equal(device.channelCount, 4);
  assert.deepEqual(
    device.properties.map((p) => p.id),
    ['mute', 'txPowerMode', 'audioMode', 'frequency', 'channelName', 'gain', 'rfEncryption']
  );
  assert.equal(device.properties.find((p) => p.id === 'gain').access, 'readOnly');
  assert.equal(device.layout.channel[0].type, 'group');
  assert.equal(device.layout.device.length, 3);

  // the complete state arrived on device-state
  await waitFor(() => stateFor(stream.records, TX_POWER_KEY).length > 0, 2000, 'state');
  assert.equal(stateFor(stream.records, 'deviceName')[0].value, 'ADTQ (simulated)');
  assert.equal(stateFor(stream.records, 'connection')[0].value.connected, true);
  assert.deepEqual(stateFor(stream.records, 'channelName')[0], {
    key: 'channelName',
    scope: 'channel',
    operation: 'merge',
    value: { channels: { 1: 'Channel1', 2: 'Channel2', 3: 'Channel3', 4: 'Channel4' } },
  });
  assert.deepEqual(stateFor(stream.records, 'frequency')[0].value, {
    channels: { 1: 470.625, 2: 471.225, 3: 471.725, 4: 472.3 },
  });
  assert.deepEqual(stateFor(stream.records, 'mute')[0].value, { channels: { 1: false, 2: false, 3: false, 4: false } });
  assert.deepEqual(stateFor(stream.records, 'rfState')[0].value, { channels: { 1: true, 2: true, 3: true, 4: true } });
  assert.deepEqual(stateFor(stream.records, 'gain')[0].value, { channels: { 1: 16, 2: 0, 3: 0, 4: 0 } });
  assert.deepEqual(stateFor(stream.records, 'groupChannel')[0].value.channels[3], { group: 1, channel: 3 });
  assert.deepEqual(stateFor(stream.records, 'audioModes')[0].value.channels[2], { txMode: 'mono' });
  assert.deepEqual(stateFor(stream.records, TX_POWER_KEY)[0].value, {
    channels: { 1: 'High', 2: 'Normal', 3: 'Normal', 4: 'Normal' },
  });
  assert.deepEqual(stateFor(stream.records, 'rfEncryption')[0].value, { mode: 'Off', enabled: false });
});

test('a command is accepted with 202 and the unit\'s read-back arrives as state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();

  const accepted = await request('POST', `${DEVICE_PATH}/commands`, {
    requestId: 'mute-1',
    propertyId: 'mute',
    channelIndex: 1,
    value: true,
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body, { requestId: 'mute-1' });
  assert.equal(fake.muted(1), true, 'the unit itself is muted');
  await waitFor(() => stateFor(stream.records, 'mute').at(-1)?.value.channels[1] === true, 2000, 'mute state');
  assert.equal(stateFor(stream.records, 'rfState').at(-1).value.channels[1], false);

  // off the 25 kHz raster: quantised before it is sent, and echoed as the unit holds it
  await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'frequency', channelIndex: 2, value: 500.113 });
  await waitFor(() => stateFor(stream.records, 'frequency').at(-1)?.value.channels[2] === 500.125, 2000, 'frequency');
  assert.equal(fake.frequencyKhz(2), 500125);

  // outside the unit's band: the unit ignores it, the state stays what the unit reads
  const refused = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'frequency', channelIndex: 2, value: 700 });
  assert.equal(refused.status, 202);
  await delay(300);
  assert.equal(fake.frequencyKhz(2), 500125);
  assert.equal(stateFor(stream.records, 'frequency').at(-1).value.channels[2], 500.125);

  await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'txPowerMode', channelIndex: 3, value: 'Low' });
  await waitFor(() => stateFor(stream.records, TX_POWER_KEY).at(-1)?.value.channels[3] === 'Low', 2000, 'tx power');

  await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'audioMode', channelIndex: 2, value: 'stereo' });
  await waitFor(() => stateFor(stream.records, 'audioModes').at(-1)?.value.channels[2]?.txMode === 'stereo', 2000, 'audio mode');

  await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'channelName', channelIndex: 4, value: 'Lead Vox' });
  await waitFor(() => stateFor(stream.records, 'channelName').at(-1)?.value.channels[4] === 'Lead Vox', 2000, 'name');
  assert.equal(fake.channelName(4), 'Lead Vox');
});

test('a command the unit cannot take is 400 with a reason', async () => {
  const unknown = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'colour', channelIndex: 1, value: 'red' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_property');

  const noChannel = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'mute', value: true });
  assert.equal(noChannel.status, 400);
  assert.equal(noChannel.body.error, 'unknown_channel');

  const badValue = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'txPowerMode', channelIndex: 1, value: 'Max' });
  assert.equal(badValue.status, 400);
  assert.equal(badValue.body.error, 'bad_value');

  const readOnly = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'gain', channelIndex: 1, value: 3 });
  assert.equal(readOnly.status, 400);
  assert.equal(readOnly.body.error, 'read_only');
});

test('a change made on the unit itself reaches the host as state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  fake.setRaw(chanAddr(3, OBJ.RF_MUTE), Buffer.from([1]));
  await waitFor(() => stateFor(stream.records, 'mute').at(-1)?.value.channels[3] === true, 2000, 'event');
  fake.setRaw(chanAddr(3, OBJ.RF_MUTE), Buffer.from([0]));
  await waitFor(() => stateFor(stream.records, 'mute').at(-1)?.value.channels[3] === false, 2000, 'event');
});

test('a unit that stops answering marks the device failed, and it reopens when it is back', async () => {
  const fake = getSimulator();
  fake.silent = true;
  const failed = await waitFor(async () => {
    const row = await deviceRow();
    return row?.status.status === 'failed' ? row : null;
  }, 10000, 'failed status');
  assert.match(failed.status.message, /stopped answering/);

  fake.silent = false;
  // the next operation reopens the device; the fake forgot the old session,
  // so this is a full new prologue
  const cmd = await request('POST', `${DEVICE_PATH}/commands`, { propertyId: 'mute', channelIndex: 1, value: false });
  assert.equal(cmd.status, 202, JSON.stringify(cmd.body));
  const ok = await waitFor(async () => {
    const row = await deviceRow();
    return row?.status.status === 'ok' ? row : null;
  }, 8000, 'ok status');
  assert.equal(ok.channelCount, 4);
  assert.equal(fake.muted(1), false);
});
