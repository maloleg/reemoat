/**
 * What the app and the daemon both speak, in one copy.
 *
 * `packages/web/src/wire.ts` is a **hand mirror** of the daemon's event
 * vocabulary and says so — the transitive closure of `src/` is not something to
 * drag into a bundle that ships to a phone. That argument does not transfer
 * here. A mirrored interface that drifts costs an `undefined` on a screen; a
 * mirrored *cryptographic protocol* that drifts costs a session that either
 * stops working or, far worse, quietly agrees on something weaker at one end.
 * So this is a package rather than a second copy.
 *
 * It is deliberately small and deliberately dependency-light: three `@noble`
 * packages and nothing else. It also **may not mention `Buffer` or any Node
 * global** — `packages/web/tsconfig.json` compiles with `types: []` on purpose,
 * so every byte string in here is a `Uint8Array` and a `Buffer` would fail the
 * web typecheck while passing the root one.
 */
export {
  FRAME,
  LengthReader,
  MAX_FRAME_PAYLOAD,
  MAX_HEADER_JSON_BYTES,
  MAX_SOCKET_MESSAGE_BYTES,
  MessageAssembler,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  tryEncodeJsonFrame,
  type CloseFrame,
  type FrameType,
  type HelloFrame,
  type OpenFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./frames.js";
export {
  CipherState,
  generateStaticKey,
  localStaticKey,
  NoiseHandshake,
  publicFromSecret,
  randomSecretKey,
  type Ephemeral,
  type NoiseOptions,
  type NoiseTransport,
  type StaticKey,
} from "./noise.js";
