import { PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "./associated-token.js";

const txlineProgram = new PublicKey(
  "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
);
const tokenMint = new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL");
const wallet = new PublicKey("rUDathrAxJK6AEksq71XvWSHzjSsFMHBrzQH2S33NVA");
const [treasury] = PublicKey.findProgramAddressSync(
  [Buffer.from("token_treasury_v2")],
  txlineProgram,
);

describe("associated token helpers", () => {
  it("derives the known TxLINE Token-2022 accounts", () => {
    expect(getAssociatedTokenAddressSync(tokenMint, wallet).toBase58()).toBe(
      "F4EgmWexjwVj9PynTZ2QVq5Fj3UZHhd8sMwrfazsFYAV",
    );
    expect(
      getAssociatedTokenAddressSync(tokenMint, treasury, true).toBase58(),
    ).toBe("DnbxehrjqjVr3YwekMiCG8Uf4KVsrgwqRmHbdxLJ3Haa");
  });

  it("rejects an off-curve owner unless explicitly allowed", () => {
    expect(() => getAssociatedTokenAddressSync(tokenMint, treasury)).toThrow(
      "Associated token owner must be on curve",
    );
  });

  it("builds the canonical associated-token create instruction", () => {
    const associatedToken = getAssociatedTokenAddressSync(tokenMint, wallet);
    const instruction = createAssociatedTokenAccountInstruction(
      wallet,
      associatedToken,
      wallet,
      tokenMint,
    );

    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(
      true,
    );
    expect(instruction.data).toHaveLength(0);
    expect(instruction.keys).toEqual([
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ]);
  });
});
