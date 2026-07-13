/**
 * Minimal TLV8 encoder for the Television service's `DisplayOrder` characteristic:
 * a flat list of tag=1 entries (one per input Identifier, in the desired display
 * order), each separated by a zero-length tag=0 delimiter. Without this, HomeKit
 * clients don't reliably show inputs in the order they were added.
 */
export function encodeDisplayOrder(identifiers: number[]): string {
  const chunks: Buffer[] = [];
  identifiers.forEach((id, index) => {
    if (index > 0) {
      chunks.push(Buffer.from([0x00, 0x00]));
    }
    const value = encodeMinimalUInt(id);
    chunks.push(Buffer.from([0x01, value.length]), value);
  });
  return Buffer.concat(chunks).toString('base64');
}

function encodeMinimalUInt(n: number): Buffer {
  if (n <= 0xff) {
    return Buffer.from([n]);
  }
  if (n <= 0xffff) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(n);
    return buf;
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}
