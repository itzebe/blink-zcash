{
  "name": "@blink/web",
  "version": "0.1.0",
  "description": "BLINK web app — private Zcash payment requests.",
  "license": "MIT",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "lint": "next lint",
    "test": "vitest run"
  },
  "dependencies": {
    "@blink/payment-request": "0.1.0",
    "@blink/shared": "0.1.0",
    "@blink/zcash": "0.1.0",
    "next": "^15.0.3",
    "qrcode": "^1.5.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "@types/qrcode": "^1.5.5",
    "@types/react": "^19.0.1",
    "@types/react-dom": "^19.0.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3"
  }
}
