# ADTQ DMP property map

Observed on a **Shure ADTQ, "ADTQ G57 NACLOCK"** (10.10.1.175, CID
`DD2D453E-0000-11DD-A000-000EDDCCCCCC`) by enumeration with
[`adtq_explore.py`](adtq_explore.py). Regenerate with:

```bash
python3 adtq_explore.py scan --ch 1 --from 0000 --to 1fff --out map.txt
```

## Address structure

    0x02 <CH> <OBJ_HI> <OBJ_LO>
      byte 0     0x02       device class
      byte 1     0x00-0x03  channel index (0 = CH1 … 3 = CH4)
      bytes 2-3  object + property index

Every object below is per-channel: add `0x00010000` per channel, so CH1 frequency is
`0x02000804` and CH3 frequency is `0x02020804`.

## Value encodings

| Kind | Format | Example |
|---|---|---|
| Integer | big-endian, 1-4 bytes | `0014` = 20 |
| Signed | two's complement | `ffffff9a` = -102 |
| String | 2-byte big-endian TOTAL length (header included), then ASCII | `000a` + `Channel1` |

## Confirmed

Verified by evidence, not inference.

| Object | Bytes | Meaning | Evidence |
|---|---|---|---|
| `0x080e` | 1 | **RF mute** (`01` = muted, `00` = unmuted) | Round-tripped SET/GET in both directions on all 4 channels |
| `0x0804` | 4 | **Frequency, kHz** | Four distinct in-band values (470.625 / 471.225 / 471.725 / 472.300 MHz), all on Shure's 25 kHz raster, for a G57 unit |
| `0x0802` | str | **Group,channel** | `"1,1"` `"1,2"` `"1,3"` `"1,4"` — tracks channel index |
| `0x08fb` | str | **Channel name** | `"Channel1"` … `"Channel4"` |
| `0x0001` | str | Channel name (mirror of `0x08fb`) | Same value, both channels checked |
| `0x0102` | 1 | **Digital audio gain, dB** — signed, raw value = dB | 16 dB -> 9 dB moved it `0x10` -> `0x09`; a full 117-property diff of that change touched only this and the encryption byte, 0 unread. Negative confirmed separately: CH2 set to -8 dB reads `0xf8`. |
| `0x0613` | 1 | **Audio mode** — `01` = Stereo, `00` = Mono (summed). Per channel. | Found by cross-channel comparison (CH2 mono was the only unexplained difference against CH3 == CH4, from 468 addresses, 0 unread), then confirmed by a prediction stated in advance: flipping CH3 to mono would move `0x02020613` `01` -> `00`. It did, while CH2 and CH4 held. |
| `0x2000` | 1 | **Encryption** (`00` = off, `03` = on). Device-wide: WWB warns the setting applies to all channels, and all four channels read identically. | Three independent readings: `00` before it was ever touched, `03` with encryption on, `00` again after turning it off. A full 117-property diff of the on->off transition moved this address and **nothing else**, with 0 addresses unread. |
| `0x0811` | 1 | **Transmit power** (enum index) | `00` = Normal, `01` = High, `02` = Low. Tracked the WWB setting across four transitions. A full-map diff of Low -> Normal moved this address and **nothing else** (1 change in 111 properties). |
| `0x0814`, `0x0884`, `0x0885` | 2 | **Power level, High vs not** | All three read 20 on High and 10 on both Normal and Low. They distinguish High from the other two but do NOT separate Normal from Low, so they cannot encode the setting on their own — `0x0811` does that. |

## Probable

Consistent with the evidence but NOT confirmed. Verify with
`python3 adtq_explore.py watch --ch 1` before relying on any of these.

| Object | Bytes | Hypothesis | Why, and what's unproven |
|---|---|---|---|
| `0x0117`-`0x011a` | 4 | RF level, dBm | Read -102/-87/-99/-88, and **drift between sweeps** while settings stay fixed — live measurement, not config. Which antenna/path each maps to is unknown. |
| `0x01d3`,`0x01d4` | 4 | RF level, dBm | -90/-89, same shape as above |
| `0x0805` | 1 | Unknown | Reads `02` on all 4 channels. Was the leading TX-power candidate on shape alone; a live power change **disproved it** — it did not move. Left unidentified. |
| `0x081f` | 1 | RF status | Reads `01` while `0x080e` reads `00`, so it is NOT a mute mirror |
| `0x0f10`-`0x0f17` | 16 | Linked-device CIDs | Slot 0 = `ff2db752-0000-11dd-a000-000eddcccccc`, Shure CID format; slots 1-7 zero. That CID advertises nowhere on the LAN. |
| `0x0f20`-`0x0f27` | 16 | Linked-device class IDs | Slot 0 ends `0015c5f3f612`, the same suffix as every DCID in the SLP adverts; slots 1-7 zero |
| `0x1000` | str | Model / slot label | `"ADXR-A"`; `0x1001`-`0x1007` all read `0002` |
| `0x1600`-`0x1632` | 1-2 | Unassigned table | All read `ff` / `00ff` (= -1 / 255), the usual "empty slot" idiom |

### TX power enum (`0x0811`) — complete

| Index | WWB label | `0x0814` / `0x0884` / `0x0885` |
|---|---|---|
| `00` | Normal | 10 |
| `01` | High | 20 |
| `02` | Low | 10 |

All three verified against the WWB display, across four transitions:
initial (High) -> Normal -> Low -> Normal -> High. The High reading was confirmed by a
prediction stated *before* the test (`0x0811` -> `01`, `0x0814` -> 20); both landed.

Full-map diffs (111 properties, 0 unanswered) at each step:

| Transition | Addresses changed |
|---|---|
| Low -> Normal | 1 — `0x0811` alone |
| Normal -> High | 4 — `0x0811`, `0x0814`, `0x0884`, `0x0885` |
| initial state -> High (round trip) | **0** — byte-for-byte identical |

The round trip is the strongest single piece of evidence here: after four setting changes
the device returned to a state indistinguishable from the first scan across every
property. That confirms the initial state was High and that nothing else drifted.

**Do not read the index as an ordering.** `00` = Normal sits between `02` = Low and
`01` = High. The values are identifiers, not a scale.

`0x0814` and its two companions read 20 on High and 10 on **both** Normal and Low, so
they track power but cannot distinguish Normal from Low. Only `0x0811` identifies the
setting uniquely. Whether 20/10 are milliwatts is unconfirmed — plausible for High and
Normal, but a "Low" that also reads 10 does not fit that reading cleanly.

## Identifying a property

Two cautionary tales here, and the second is the sharper one.

`0x0805` reads `02` on every channel — a constant single byte sitting two addresses from
frequency, exactly what a power enum looks like. It is not. A live power change left it
untouched. Value *shape* generates hypotheses, never evidence.

`0x0814` is the subtler trap: it moved 20 -> 10 in lockstep with the first power change,
on the right channel, while 416 other properties stayed still. "Power in mW" fit
perfectly. It was still wrong — the next change (Normal -> Low) moved `0x0811` and left
`0x0814` alone. It turned out to be power-related but unable to separate Normal from Low.
**One correlated change is not identification.** Take a second data point on a different
transition before believing an address.

The third lesson cost the most time and had nothing to do with the device: a state was
reported as "High" when WWB was actually displaying "Normal". The device had been
self-consistent throughout; the label was wrong. Before concluding that hardware is
behaving contradictorily, re-verify what the control surface actually shows. The fix was
to state a falsifiable prediction *before* the next test — `0x0811` -> `01` and
`0x0814` -> 20 — and check it, rather than fitting a story to whatever arrived.

To identify a property, watch the whole known map and change the control:

```bash
python3 adtq_explore.py watch --objects objects.txt
```

Two practical notes. Change the setting on **one channel** if you can — the per-channel
address falls straight out of it. And `watch` suppresses the RF level readings by default
(`--ignore`), because they drift a few dB every poll and otherwise bury the single
discrete change you are looking for in a wall of noise.

### Audio mode (`0x0613`)

| Value | Mode |
|---|---|
| `01` | Stereo |
| `00` | Mono (summed) |

Per channel, unlike encryption. Confirmed on two channels independently.

`0x0612` sits adjacent and is **not** part of this: it reads `00` on CH1 and `01` on
CH2/3/4 regardless of mode (CH4 is stereo and reads `01`, CH1 is stereo and reads `00`).
It tracks something CH1-specific and remains unidentified.

### Digital gain (`0x0102`)

Single byte, value **is** the dB figure — 16 dB reads `0x10`, 9 dB reads `0x09`. Per
channel: CH2-4 read `00` (0 dB) while CH1 was set.

**Negative gain confirmed** as two's complement: CH2 set to -8 dB reads `0xf8`. Decode
the byte as signed, not unsigned — an unsigned read reports 248 dB. Range is therefore
-128..127 dB nominally, though the device's own usable range will be narrower.

### Encryption (`0x2000`)

| Value | State |
|---|---|
| `00` | off (confirmed) |
| `03` | on (confirmed) |

`03` rather than `01` suggests an enum or bitmask — possibly a cipher/mode selector — so
do not assume any non-zero value means "on", and do not assume `01` is valid. Only these
two values have been observed.

WWB warns that the setting applies to **all channels**, and all four channels read the
same value. Whether the device stores one shared value or four replicated copies is
untested; writing a single channel's copy would distinguish them, but that is a
device-wide security setting and was not written here.

This property sits at object `0x2000`, **outside** the `0x0000`-`0x1fff` range that every
earlier sweep covered. It was only findable because a sparse probe of `0x2000`-`0xffff`
turned up isolated properties at `0x2000` and `0x4000`. Had the diff been run over the
original range it would have come back empty, and the obvious (wrong) conclusion would
have been that encryption is not exposed over DMP at all. Absence of evidence is only
evidence of absence once the search space is known.

## Scanning caveat

The device answers **every** GET — `GET_REPLY` (vec 3) if the property exists,
`GET_FAIL` (vec 9, reason `0x02`) if it does not. Silence therefore always means a lost
packet, never an absent property.

This matters. A first sweep at a flat 16-GETs-per-20ms lost **41% of its probes** and
reported 84 properties; with retries the same range returns **111 properties and zero
unanswered**. The 27 recovered addresses were an entire contiguous block (`0x1600`+)
that the fast sweep missed completely. `scan()` now re-fires anything that stays silent,
halving the burst and doubling the gap each round, and reports whatever is still
unanswered as UNKNOWN rather than absent.

## Note on the DDL

The SLP advert points at `tftp://<ip>/$.ddl`, which would name every property, but the
ADTQ runs no TFTP server (and no open TCP ports at all), so it cannot be fetched from
the device. Wireless Workbench ships the same data locally at
`Wireless Workbench.app/Contents/Resources/Data/DDL.dat`, but it is an AES-encrypted ZIP.
Enumeration plus `watch` is the route used here.
