/** Binary envelope for the live socket: JSON metadata followed by frame bytes. */
export function packLive(meta, payload = new Uint8Array()) {
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + header.length + payload.byteLength);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(payload, 4 + header.length);
  return out;
}

export function unpackLive(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (data.byteLength < 4) throw new Error('truncated live frame');
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (length < 1 || length > 16000 || length + 4 > data.byteLength) throw new Error('invalid live header');
  const meta = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length)));
  if (!Number.isSafeInteger(meta.id) || meta.id < 0) throw new Error('invalid live frame id');
  return { meta, payload: data.subarray(4 + length) };
}
