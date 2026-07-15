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
 * Builds the raw (pre-base64) scene-param bytes for a multi-layer H6022
 * matrix scene. Blocks get z-order 1..n (block 0 topmost).
 */
function buildMatrixSceneParam(blocks: MatrixBlock[]): number[] {
  const rendered = blocks.map((blk, i) => {
    const gdata = groupBytes(blk.groups);
    const zOrder = (i + 1) & 0xff;
    const tail = [blk.rate & 0xff, blk.level & 0xff, blk.mode & 0xff, 0x00, zOrder, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00];
    return { gdata, tail };
  });

  const data: number[] = [
    0x41,
    // Main header: background RGB + opacity (kept black/transparent here),
    // 0x00 = render layers simultaneously (0x01 would be carousel), block count.
    0x00, 0x00, 0x00, 0x00, 0x00, blocks.length & 0xff,
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

/** Milliseconds each red/blue phase of Police Strobo lasts. */
const STROBE_PHASE_MS = 400;
const STROBE_RED: [number, number, number] = [255, 0, 0];
const STROBE_BLUE: [number, number, number] = [0, 0, 255];

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
 * All rates/levels/colors are first-guess values meant to be tuned on the
 * real lamp.
 */
function buildStormScene(): number[] {
  const lightning: MatrixGroup = {
    color: [255, 255, 255],
    leds: [led(2, 3), led(3, 4), led(4, 3), led(5, 4), led(2, 8), led(3, 9), led(4, 8)],
  };
  const cloud: MatrixGroup = {
    color: [115, 125, 145],
    leds: range(led(0, 0), led(1, 11)),
  };
  const rain: MatrixGroup = {
    color: [25, 60, 255],
    leds: [
      led(2, 1), led(2, 6), led(2, 10),
      led(3, 3), led(3, 7), led(3, 11),
      led(4, 0), led(4, 5), led(4, 9),
      led(5, 2), led(5, 7), led(5, 11),
      led(6, 4), led(6, 8), led(6, 0),
      led(7, 1), led(7, 6), led(7, 10),
      led(8, 3), led(8, 8), led(8, 11),
      led(9, 0), led(9, 5), led(9, 9),
      led(10, 2), led(10, 7), led(10, 11),
    ],
  };

  return buildMatrixSceneParam([
    { groups: [lightning], mode: 0x00, rate: 95, level: 100 },
    { groups: [cloud], mode: 0x00, rate: 12, level: 65 },
    { groups: [rain], mode: 0x02, rate: 75, level: 100 },
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
// LAN transport
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget UDP sender for one lamp. The LAN API has no delivery
 * acknowledgment for control commands, so errors are only logged; state
 * verification stays with gv2mqtt's normal reporting path.
 */
export class H6022Lan {
  private socket?: dgram.Socket;
  private strobeTimer?: NodeJS.Timeout;

  constructor(
    private readonly ip: string,
    private readonly deviceName: string,
    private readonly log: Logger,
  ) {}

  private send(msg: Record<string, unknown>): void {
    if (!this.socket) {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => {
        this.log.warn(`[${this.deviceName}] LAN UDP socket error: ${err.message}`);
      });
    }
    const buf = Buffer.from(JSON.stringify({ msg }));
    this.socket.send(buf, CONTROL_PORT, this.ip, (err) => {
      if (err) {
        this.log.warn(`[${this.deviceName}] LAN send to ${this.ip}:${CONTROL_PORT} failed: ${err.message}`);
      }
    });
  }

  private sendColor([r, g, b]: [number, number, number]): void {
    this.send({ cmd: 'colorwc', data: { color: { r, g, b }, colorTemInKelvin: 0 } });
  }

  /**
   * Red/blue police strobe, driven from this side: the firmware's DIY modes
   * have no reliable "alternate solid fills" primitive, so the plugin just
   * flips the whole lamp between red and blue every STROBE_PHASE_MS over the
   * local LAN (no cloud round-trips involved).
   */
  startPoliceStrobo(): void {
    this.stop();
    let red = true;
    this.sendColor(STROBE_RED);
    this.strobeTimer = setInterval(() => {
      red = !red;
      this.sendColor(red ? STROBE_RED : STROBE_BLUE);
    }, STROBE_PHASE_MS);
  }

  /** Uploads and activates the storm matrix scene; the firmware animates it from there. */
  startStorm(): void {
    this.stop();
    this.send({ cmd: 'ptReal', data: { command: stormScenePackets() } });
  }

  /**
   * Stops any plugin-driven animation timer. Restoring what the lamp showed
   * before is the caller's job (GoveeDevice.restoreSnapshot over MQTT).
   */
  stop(): void {
    if (this.strobeTimer) {
      clearInterval(this.strobeTimer);
      this.strobeTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.socket?.close();
    this.socket = undefined;
  }
}
