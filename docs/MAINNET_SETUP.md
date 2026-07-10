# Solana mainnet and TxLINE setup

## Locked network

The judged integration is mainnet-first:

- RPC: `https://api.mainnet-beta.solana.com`
- TxLINE program: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`
- Token-2022 TxL mint: `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL`
- API: `https://txline.txodds.com`
- Service level: `12` (free real-time World Cup tier)

Devnet is not silently substituted. Any fallback must be disclosed.

## Activation

Create or inspect the dedicated wallet:

```bash
pnpm wallet:create
pnpm txline:inspect
```

Fund the printed address with enough SOL for the Token-2022 associated account
and transaction fees. The activation command currently requires at least
`0.005 SOL` before it will send anything.

```bash
pnpm txline:activate
```

The command:

1. validates the mainnet origin, program ID, and service level;
2. creates the TxL Token-2022 associated account when absent;
3. calls `subscribe(12, 4)`;
4. signs the activation message with the same wallet;
5. stores the returned API token in ignored `.env` with mode `0600`.

Run the gate probe afterward:

```bash
pnpm g1:probe
```

After G1 reports both streams connected, start the supervised worker:

```bash
pnpm worker:live
```

The worker exits if no API token exists. It never logs raw feed payloads to
stdout; raw capture files remain under ignored `data/private/`.

## Secret handling

- `.secrets/`, `.env`, raw captures, and runtime data are ignored.
- Browser JavaScript never receives the API token or wallet key.
- No private key is accepted through a Vite-prefixed environment variable.
- Public output reports token presence, never token contents.
