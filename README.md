# Shure ADTQ — SoundBase plugin

Puts a Shure **ADTQ** four-channel Axient Digital PSM transmitter into
SoundBase's device monitoring, over the network, with no Wireless Workbench in
the loop: every channel's name, frequency, group/channel, RF power, gain,
audio mode and RF mute state on a card, and RF mute, frequency, RF power,
audio mode and name writable from it.

```
SoundBase ──spawns──► plugin (node) ──UDP: SLP + ACN SDT/DMP──► ADTQ
             HTTP/SSE                  the same protocol Workbench speaks
```

The plugin speaks ANSI E1.17 (ACN) directly — the SLP discovery, the SDT
session handshake, the encrypted DMP property channel — ported from a
reverse-engineered Python tool that mutes a real ADTQ, and pinned to that
tool's bytes by test vectors. [docs/adtq-protocol.md](docs/adtq-protocol.md)
is the wire; [docs/adtq-properties.md](docs/adtq-properties.md) is the property
map and the evidence behind every address.

---

## Try it

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # 33 tests: crypto and PDU vectors, the driver against a
                    # fake ADTQ, the adapter through the real shell
npm run smoke       # boots main.js as SoundBase does and drives the fake
```

Nothing above needs hardware. The fake ADTQ (`driver/fake/fake-adtq.js`)
speaks the real wire protocol on loopback — SLP, the session prologue, the
encrypted DMP exchange, the CID check that drops a JOIN in silence — and holds
the property map observed on a real unit.

### With a real unit

The command-line tool talks to a unit through the plugin's own driver, with
SoundBase nowhere in the picture. It is the thing to reach for in the first
hour with real hardware:

```sh
npm run adtq -- discover                     # who answers service:esta.dmp?
npm run adtq -- status 10.10.1.175           # every mapped property, all four channels
npm run adtq -- watch  10.10.1.175           # print what the unit pushes when you change something
npm run adtq -- mute   10.10.1.175 1 on      # RF mute channel 1; confirmed by read-back
npm run adtq -- power  10.10.1.175 2 low
npm run adtq -- mode   10.10.1.175 2 mono
npm run adtq -- freq   10.10.1.175 3 500.125 # asks first: retuning drops the RF link
npm run adtq -- name   10.10.1.175 4 "Lead Vox"
```

Every write is followed by a read of the same property and reported as
`CONFIRMED` or `NOT APPLIED`, because a SET the device silently ignores is
otherwise indistinguishable from one that worked.

Then, with SoundBase, `SB_ADTQ_HOST=10.10.1.175 npm run smoke` adds the real
unit alongside the simulated one and reads it. It changes nothing on it.

### In SoundBase

Put the folder where SoundBase looks for plugins, or point `SB_PLUGIN_DIRS` at
its parent — [docs/running-in-soundbase.md](docs/running-in-soundbase.md).
Units on the machine's network segment are discovered by SLP multicast and
appear in the device setup drawer; units elsewhere can be added by IP address
or listed under **Additional ADTQ addresses** in the plugin's settings. Tick
**Simulate an ADTQ** to get a simulated unit with no hardware at all.

## What is exposed

| On the card | State key | Source | Writable |
|---|---|---|---|
| Channel name | `channelName` | `0x08fb`, confirmed | yes (`channelName`) — see *unverified* below |
| Frequency, MHz | `frequency` | `0x0804` kHz, confirmed | yes (`frequency`), 25 kHz raster |
| Group, channel | `groupChannel` `{ group, channel }` | `0x0802`, confirmed | no |
| RF mute | `mute`, and `rfState` = not muted | `0x080e`, confirmed by SET round trip | yes (`mute`) |
| RF power | `x.shure-adtq.txPowerMode` — `Normal` / `High` / `Low` | `0x0811` enum, confirmed over four transitions | yes (`txPowerMode`) |
| Gain, dB | `gain` | `0x0102` signed byte, confirmed | **no**, by design |
| Audio mode | `audioModes.txMode` — `stereo` / `mono` | `0x0613`, confirmed | yes (`audioMode`) |
| Encryption | `rfEncryption` `{ mode, enabled }`, device-wide | `0x2000`, confirmed | **no**, by design |
| Unit name | `deviceName` | the SLP `acn-uacn` string | no |

RF power is an extension key rather than SoundBase's `txPower` (milliwatts):
the ADTQ exposes an enum whose indices are identifiers, not a scale (`0` sits
between `2` and `1`), and the companion level property reads the same on
Normal and Low, so no honest mW figure exists for it.

**Read-only on purpose.** Gain raises the level in someone's ears; encryption
is device-wide and forces every receiver to re-sync. Both are shown and
neither is changed here — change them in Workbench.

**Not exposed.** The live RF level readings (`0x0117`–`0x011a`) drift every
read and their meaning on a transmitter is unidentified; they are not
presented as meters. The device's band limits are not readable over DMP, so
the frequency property spans UHF (400–1000 MHz); a value outside the unit's
band is refused by the unit and the card keeps showing what it actually holds.

## Verification status — read this before trusting it

| Layer | Proof |
|---|---|
| Session key, AES-CTR, SKIP32 tag, every PDU builder and parser, the SLP advert | byte-exact against the Python reference that has muted a real ADTQ (`__tests__/fixtures/acn-vectors.json`) |
| Session prologue, reads, writes with read-back, EVENTs, loss, silence, disconnect | against the fake, which is built from the same primitives and the captured behaviour |
| The adapter and the SoundBase contract | through the real `@soundbase/plugin-shell` over HTTP |
| **This plugin against a real ADTQ** | **not yet run.** The Python tool it was ported from has been run against one; this port has not. `npm run adtq -- status <ip>` is the first thing to do with a unit in reach. |
| Channel-name writes | never exercised on hardware, not even by the Python tool. The encoding is the one the device uses for reads; the read-back will say whether it took. |

## Requirements

- Node 20 or newer; no native modules.
- The machine on the same network as the ADTQ, with UDP 8427 (SLP) open in
  both directions. The devices answer SLP **to port 8427**, not to the
  request's source port, so the plugin binds it; when Workbench already owns
  it discovery still works but is less reliable.
- Nothing else holding a session with the unit. A unit that joins but does not
  take writes is usually one Workbench is also controlling.

## Scripts

| | |
|---|---|
| `npm start` | run the plugin |
| `npm test` | the suite |
| `npm run doctor` | is this plugin well-formed? with fixes for anything that isn't |
| `npm run smoke` | boot as a child process, handshake, drive the simulated unit — what the host does |
| `npm run adtq -- …` | discover, read and control a unit from the terminal |
| `npm run manifest` | validate `soundbase-plugin.json` against the contract schema |
| `npm run pack:release` | build the zip users install, and boot-check it |
| `npm run release <x.y.z>` | tag, pack, and publish a GitHub Release |

Environment knobs, mainly for tests and CI: `SB_ADTQ_SIMULATE=1` (the
simulated unit), `SB_ADTQ_SLP_PORT` (an SLP port other than 8427),
`SB_ADTQ_NO_MULTICAST=1`, `SB_ADTQ_NO_DISCOVERY=1`, `SB_ADTQ_HOST` (smoke
check against a real unit).

## Layout

```
soundbase-plugin.json   identity, the ADTQ product, its layout and config fields
main.js                 shell bootstrap — never edited
adapter.js              the device on the contract: discovery, state, commands
driver/
  netutil.js            interface selection, address parsing
  acn/crypto.js         session key, AES-CTR, SKIP32 tag
  acn/pdu.js            ACN root / SDT / DMP codec and builders
  acn/slp.js            discovery request, controller advert, reply parser, the standing browse
  acn/session.js        the held-open SDT session: prologue, acks, NAKs, request/reply
  adtq/properties.js    the address map and value codecs
  adtq/device.js        typed reads and writes with read-back, the change feed
  fake/fake-adtq.js     a fake unit on the same wire, for tests and the simulator
__tests__/              vectors, driver against the fake, adapter through the shell
scripts/                adtq CLI, smoke, doctor, manifest, rename, bump, release, pack
docs/                   the SDK guide set, plus adtq-protocol.md and adtq-properties.md
```

## Licence

Business Source License 1.1 — see `LICENSE`. Protocol knowledge here comes
from observing an operator-owned ADTQ with Wireless Workbench; no Shure
software is included or required.
