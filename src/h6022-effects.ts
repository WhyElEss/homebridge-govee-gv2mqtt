import * as dgram from 'dgram';
import { Logger } from 'homebridge';

/**
 * Direct LAN control of a Govee Table Lamp 2 (H6022) for effects that
 * gv2mqtt/Govee's cloud API cannot express.
 *
 * Two transports over the lamp's local UDP control port (4003), both taken
 * verbatim from govee2mqtt's lan_api.rs (Request enum, serde tag="cmd",
 * content="data"):
 *
 *   - "colorwc": plain whole-lamp color; used by the Police Strobo effect,
 *     which alternates red/blue on a plugin-side timer.
 *   - "ptReal": base64-encoded 20-byte BLE-style packets tunneled over the
 *     LAN API; used to upload a custom DIY "matrix scene" (the H6022 is an
 *     11x12 addressable matrix, LED index = row * 12 + col, 132 LEDs total).
 *     The lamp's firmware then animates the scene on its own - nothing needs
 *     to stream afterwards.
 *
 * The matrix-scene byte format is a port of dvdavd/govee-lan-ha's
 * govee_scene.py (build_h6022_matrix_scene_multi + _scene_packets), which in
 * turn builds on AlgoClaw/Govee and egold555/Govee-Reverse-Engineering. The
 * H6022-specific parts are: scene code 8505, and the 0x41 -> 0x58 0x5a
 * scene-param prefix rewrite.
 */

const CONTROL_PORT = 4003;

/** DIY/matrix scenes on the H6022 all activate through this scene code. */
const H6022_MATRIX_SCENE_CODE = 8505;

export const H6022_ROWS = 11;
export const H6022_COLS = 12;

/** One drawn color group inside a matrix-scene layer. */
interface MatrixGroup {
  color: [number, number, number];
  /** LED indices 0-131; row = index / 12, col = index % 12 (row 0 at the top). */
  leds: number[];
}

/**
 * One animation layer ("block") of a matrix scene. Earlier blocks render on
 * top of later ones. mode: 0x00 twinkle, 0x01 up, 0x02 down, 0x03 left,
 * 0x04 right, 0x05-0x08 diagonals - moving modes scroll the whole layer with
 * wraparound; twinkle fades pixels in and out in place.
 */
interface MatrixBlock {
  groups: MatrixGroup[];
  mode: number;
  /** Movement/twinkle cadence, 0-100. */
  rate: number;
  /** Layer brightness/duty, 0-100. */
  level: number;
}

/** Pads a command to 19 bytes and appends the XOR checksum (20-byte BLE packet). */
function finishPacket(data: number[]): number[] {
  let checksum = 0;
  for (const b of data) {
    checksum ^= b;
  }
  const out = [...data];
  while (out.length < 19) {
    out.push(0);
  }
  out.push(checksum);
  return out;
}

function groupBytes(groups: MatrixGroup[]): number[] {
  const out: number[] = [];
  for (const g of groups) {
    out.push(g.leds.length & 0xff, g.color[0] & 0xff, g.color[1] & 0xff, g.color[2] & 0xff);
    for (const i of g.leds) {
      out.push(i & 0xff);
    }
  }
  return out;
}

/** 6-byte block-info header used both in the main header and between blocks. */
function blockHeader(groupsSize: number, numGroups: number): number[] {
  return [(groupsSize + 15) & 0xff, 0x00, 0x03, (groupsSize + 1) & 0xff, 0x00, numGroups & 0xff];
}

/**
 * Builds the raw (pre-base64) scene-param bytes for a multi-block H6022
 * matrix scene. In layer mode (default) all blocks render simultaneously
 * with z-order 1..n (block 0 topmost); in carousel mode the firmware shows
 * the blocks one after another in a loop, i.e. each block is one animation
 * frame.
 */
function buildMatrixSceneParam(blocks: MatrixBlock[], carousel = false): number[] {
  const rendered = blocks.map((blk, i) => {
    const gdata = groupBytes(blk.groups);
    const zOrder = (i + 1) & 0xff;
    const tail = [blk.rate & 0xff, blk.level & 0xff, blk.mode & 0xff, 0x00, zOrder, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00];
    return { gdata, tail };
  });

  const data: number[] = [
    0x41,
    // Main header: background RGB + opacity (kept black/transparent here),
    // render mode (0x00 = simultaneous layers, 0x01 = carousel), block count.
    0x00, 0x00, 0x00, 0x00, carousel ? 0x01 : 0x00, blocks.length & 0xff,
    ...blockHeader(rendered[0].gdata.length, blocks[0].groups.length),
  ];
  rendered.forEach(({ gdata, tail }, i) => {
    if (i > 0) {
      data.push(...blockHeader(gdata.length, blocks[i].groups.length));
    }
    data.push(...gdata, ...tail);
  });
  return data;
}

/**
 * Wraps a scene param into the multi-packet a3-framed upload plus the final
 * "activate scene" command, as a list of base64 20-byte packets ready for a
 * single ptReal command.
 */
function scenePackets(sceneParam: number[]): string[] {
  // H6022 scene-param prefix rewrite (dvdavd's _SCENE_PROFILES["H6022"]):
  // matrix params start 0x41 and go on the wire as 0x58 0x5a.
  let raw: number[];
  if (sceneParam[0] === 0x41) {
    raw = [0x58, 0x5a, ...sceneParam.slice(1)];
  } else {
    throw new Error(`unsupported H6022 scene param prefix 0x${sceneParam[0]?.toString(16)}`);
  }

  const data: number[] = [0xa3, 0x00, 0x01, 0x00];
  let numLines = 0;
  let lastLineMarker = 1;
  for (const b of raw) {
    if (data.length % 19 === 0) {
      numLines += 1;
      data.push(0xa3);
      lastLineMarker = data.length;
      data.push(numLines);
    }
    data.push(b);
  }
  data[lastLineMarker] = 0xff;
  data[3] = numLines + 1;

  const bytes: number[] = [];
  for (let i = 0; i < data.length; i += 19) {
    bytes.push(...finishPacket(data.slice(i, i + 19)));
  }
  const lo = H6022_MATRIX_SCENE_CODE & 0xff;
  const hi = (H6022_MATRIX_SCENE_CODE >> 8) & 0xff;
  bytes.push(...finishPacket([0x33, 0x05, 0x04, lo, hi]));

  const packets: string[] = [];
  for (let i = 0; i < bytes.length; i += 20) {
    packets.push(Buffer.from(bytes.slice(i, i + 20)).toString('base64'));
  }
  return packets;
}

// ---------------------------------------------------------------------------
// Effect definitions
// ---------------------------------------------------------------------------

function led(row: number, col: number): number {
  return row * H6022_COLS + col;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) {
    out.push(i);
  }
  return out;
}

/**
 * Police Strobo, after GyverLamp's policeStrobo pattern 3: the lamp is split
 * horizontally into a blue half and a red half that swap places on every
 * beat, with a static white dividing line across the middle - the "steel
 * frame" of a police light bar.
 *
 * Built as a two-frame carousel scene (frame 1: blue top / red bottom,
 * frame 2: swapped; the white divider is drawn in both), so the firmware
 * does the alternation itself - no network traffic while running, and the
 * frame switch is instant. rate 100 asks for the fastest carousel cadence.
 */
function buildPoliceStroboScene(): number[] {
  const RED: [number, number, number] = [255, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 255];
  const WHITE: [number, number, number] = [255, 255, 255];
  const topHalf = range(led(0, 0), led(4, 11));
  const divider = range(led(5, 0), led(5, 11));
  const bottomHalf = range(led(6, 0), led(10, 11));

  const frame = (top: [number, number, number], bottom: [number, number, number]): MatrixBlock => ({
    groups: [
      { color: top, leds: topHalf },
      { color: WHITE, leds: divider },
      { color: bottom, leds: bottomHalf },
    ],
    mode: 0x00,
    rate: 100,
    level: 100,
  });

  return buildMatrixSceneParam([frame(BLUE, RED), frame(RED, BLUE)], true);
}

let policePacketsCache: string[] | null = null;
export function policeStroboPackets(): string[] {
  if (!policePacketsCache) {
    policePacketsCache = scenePackets(buildPoliceStroboScene());
  }
  return policePacketsCache;
}

/**
 * "Гроза в банке": a storm-cloud composition in the spirit of GyverLamp's
 * rain/thunderstorm effects, recomposed for the H6022's 11x12 cylinder out
 * of firmware-animated layers (top to bottom z-order):
 *
 *   1. lightning - white pixels zig-zagging down from the cloud, twinkling
 *      fast so they read as intermittent flashes;
 *   2. cloud     - the top two rows in gray, twinkling slowly;
 *   3. rain      - scattered blue drops scrolling down with wraparound
 *      (they pass behind the cloud layer while wrapping).
 *
 * Layer timing semantics (from dvdavd/govee-h6022-ble's calibrated preview,
 * govee-matrix.js): a twinkle layer pulses on a sine with period
 * 5500 - rate*50 ms (floor 500ms) between 18% and 100% alpha, and rate 0
 * means fully static; a moving layer completes a full wrap loop in
 * 13000 - rate*117 ms (floor 1300ms).
 */
function buildStormScene(): number[] {
  const lightning: MatrixGroup = {
    color: [255, 255, 255],
    leds: [led(2, 3), led(3, 4), led(4, 3), led(5, 4), led(2, 8), led(3, 9), led(4, 8)],
  };
  const cloud: MatrixGroup = {
    // Dim and bluish on purpose: a "gray" on RGB LEDs is just faint white,
    // which made the cloud read as the same color as the lightning.
    color: [45, 60, 110],
    leds: range(led(0, 0), led(1, 11)),
  };
  // [row, col] of each raindrop head; the tail layer hangs one row above,
  // at reduced brightness, so drops read as fast streaks instead of dots.
  const drops: Array<[number, number]> = [
    [2, 1], [2, 6], [2, 10],
    [3, 3], [3, 7], [3, 11],
    [4, 0], [4, 5], [4, 9],
    [5, 2], [5, 7], [5, 11],
    [6, 0], [6, 4], [6, 8],
    [7, 1], [7, 6], [7, 10],
    [8, 3], [8, 8], [8, 11],
    [9, 0], [9, 5], [9, 9],
    [10, 2], [10, 7], [10, 11],
  ];
  const rain: MatrixGroup = {
    color: [25, 60, 255],
    leds: drops.map(([r, c]) => led(r, c)),
  };
  const rainTails: MatrixGroup = {
    color: [25, 60, 255],
    // Wraps at the top edge; wrapped tails land on the cloud rows, where the
    // cloud block (higher z-order) hides them.
    leds: drops.map(([r, c]) => led((r + H6022_ROWS - 1) % H6022_ROWS, c)),
  };

  return buildMatrixSceneParam([
    // twinkle @ 100: the firmware's fastest flicker (~0.5s period).
    { groups: [lightning], mode: 0x00, rate: 100, level: 100 },
    // twinkle @ 0: fully static (a non-zero rate made the whole cloud fade
    // in and out on a ~5s sine, disappearing half the time).
    { groups: [cloud], mode: 0x00, rate: 0, level: 40 },
    // down @ 100: the firmware's fastest scroll, a full wrap loop every
    // ~1.3s (~118ms per row). Bytes above 100 don't go faster - they break
    // the movement entirely (0x70 was observed to stop a moving layer).
    { groups: [rain], mode: 0x02, rate: 100, level: 100 },
    { groups: [rainTails], mode: 0x02, rate: 100, level: 45 },
  ]);
}

/** Base64 ptReal packets for the storm scene, built once on first use. */
let stormPacketsCache: string[] | null = null;
export function stormScenePackets(): string[] {
  if (!stormPacketsCache) {
    stormPacketsCache = scenePackets(buildStormScene());
  }
  return stormPacketsCache;
}

// ---------------------------------------------------------------------------
// LAN discovery
// ---------------------------------------------------------------------------

const MULTICAST_ADDR = '239.255.255.250';
const SCAN_PORT = 4001;
/** Govee devices always send scan replies to UDP 4002 of the requesting host. */
const RESPONSE_PORT = 4002;
/** How long to keep port 4002 open collecting scan replies. */
const SCAN_WINDOW_MS = 1500;
/** Don't re-scan more often than this when refreshes are requested back-to-back. */
const SCAN_MIN_INTERVAL_MS = 30000;

/** Config deviceId "18DFD0C806467677" and scan-reply device "18:DF:D0:C8:06:46:76:77" both normalize to the former. */
function normalizeDeviceId(id: string): string {
  return id.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

let inflightScan: Promise<Map<string, string>> | null = null;

/**
 * One multicast LAN scan, shared by all lamps: binds UDP 4002, multicasts a
 * scan request, and collects replies for SCAN_WINDOW_MS. Resolves to a map
 * of normalized device ID -> IP (empty on failure - notably when 4002 is
 * already taken by another Govee LAN controller on this host, e.g. a
 * host-networked govee2mqtt; callers then fall back to a configured lanIp).
 * The port is only held for the scan window, never permanently. Concurrent
 * callers share one in-flight scan rather than fighting over the port.
 */
export function scanLanDevices(log: Logger): Promise<Map<string, string>> {
  if (inflightScan) {
    return inflightScan;
  }
  const scan = new Promise<Map<string, string>>((resolve) => {
    const found = new Map<string, string>();
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      inflightScan = null;
      try {
        socket.close();
      } catch {
        // Already closed (e.g. finishing from the error handler).
      }
      resolve(found);
    };

    socket.on('error', (err) => {
      log.warn(`Govee LAN scan unavailable (${err.message}); will fall back to configured lanIp if set`);
      finish();
    });
    socket.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString()).msg;
        if (msg?.cmd === 'scan' && typeof msg.data?.ip === 'string' && typeof msg.data?.device === 'string') {
          found.set(normalizeDeviceId(msg.data.device), msg.data.ip);
        }
      } catch {
        // Not a scan reply; ignore.
      }
    });
    socket.bind(RESPONSE_PORT, () => {
      const req = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
      socket.send(req, SCAN_PORT, MULTICAST_ADDR, (err) => {
        if (err) {
          log.warn(`Govee LAN scan request failed: ${err.message}`);
          finish();
        }
      });
      setTimeout(finish, SCAN_WINDOW_MS);
    });
  });
  inflightScan = scan;
  return scan;
}

// ---------------------------------------------------------------------------
// LAN transport
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget UDP sender for one lamp. The LAN API has no delivery
 * acknowledgment for control commands, so errors are only logged; state
 * verification stays with gv2mqtt's normal reporting path.
 *
 * The lamp's IP is auto-discovered via scanLanDevices (matched by device
 * ID), cached, and refreshed in the background around each activation; a
 * configured lanIp is only a fallback for when scanning isn't possible.
 * Commands resolve the target at send time.
 */
export class H6022Lan {
  private socket?: dgram.Socket;
  private discoveredIp: string | null = null;
  private lastScanAt = 0;
  private readonly deviceId: string;

  constructor(
    deviceId: string,
    private readonly fallbackIp: string,
    private readonly deviceName: string,
    private readonly log: Logger,
  ) {
    this.deviceId = normalizeDeviceId(deviceId);
    // Warm the cache so the first activation doesn't have to wait for a scan.
    void this.refreshIp();
  }

  private target(): string | null {
    return this.discoveredIp ?? (this.fallbackIp || null);
  }

  private async refreshIp(force = false): Promise<void> {
    // The throttle only applies to opportunistic background refreshes;
    // a forced refresh (nothing known yet) always scans.
    if (!force && Date.now() - this.lastScanAt < SCAN_MIN_INTERVAL_MS) {
      return;
    }
    this.lastScanAt = Date.now();
    const devices = await scanLanDevices(this.log);
    const ip = devices.get(this.deviceId);
    if (ip) {
      if (ip !== this.discoveredIp) {
        this.log.info(`[${this.deviceName}] LAN scan found the lamp at ${ip}`);
      }
      this.discoveredIp = ip;
    } else if (!this.target()) {
      this.log.warn(
        `[${this.deviceName}] LAN scan did not find this lamp and no lanIp is configured; ` +
          'custom effects cannot be sent. Is LAN Control enabled for it in the Govee Home app?',
      );
    }
  }

  /**
   * Resolves the IP to use for an activation: an already-known target is
   * returned immediately (with a background refresh for next time, so a
   * DHCP-changed address costs at most one missed activation); otherwise
   * this blocks on a scan. Null when nothing is known even after scanning.
   */
  async ensureTarget(): Promise<string | null> {
    if (this.target()) {
      void this.refreshIp();
      return this.target();
    }
    await this.refreshIp(true);
    return this.target();
  }

  private send(msg: Record<string, unknown>): void {
    const ip = this.target();
    if (!ip) {
      this.log.debug(`[${this.deviceName}] dropping LAN command - lamp IP unknown`);
      return;
    }
    if (!this.socket) {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => {
        this.log.warn(`[${this.deviceName}] LAN UDP socket error: ${err.message}`);
      });
    }
    const buf = Buffer.from(JSON.stringify({ msg }));
    this.socket.send(buf, CONTROL_PORT, ip, (err) => {
      if (err) {
        this.log.warn(`[${this.deviceName}] LAN send to ${ip}:${CONTROL_PORT} failed: ${err.message}`);
      }
    });
  }

  /** Powers the lamp on without touching its color (a scene upload alone may arrive while it's off). */
  private sendTurnOn(): void {
    this.send({ cmd: 'turn', data: { value: 1 } });
  }

  /**
   * Uploads and activates the police-strobo carousel scene; the firmware
   * alternates the two frames on its own from there. Stopping the effect is
   * the caller's job (GoveeDevice.restoreSnapshot over MQTT).
   */
  startPoliceStrobo(): void {
    this.sendTurnOn();
    this.send({ cmd: 'ptReal', data: { command: policeStroboPackets() } });
  }

  /** Uploads and activates the storm matrix scene; the firmware animates it from there. */
  startStorm(): void {
    this.sendTurnOn();
    this.send({ cmd: 'ptReal', data: { command: stormScenePackets() } });
  }

  dispose(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
