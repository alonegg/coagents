import { hash, verify } from "@node-rs/argon2";

// argon2id with library defaults (m=19456 KiB, t=2, p=1), per OWASP guidance.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// Used when the username does not exist so both paths spend comparable time.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash("coagents-dummy-password");
  await verifyPassword(await dummyHash, password);
}
