# Printing Kept labels on a NIIMBOT B21S-C2B

Run the bridge on the computer that can reach the printer. Kept renders the QR and short ID at the chosen roll size and sends a PNG to the bridge. A phone needs only its ordinary Kept session. The connection key stays on the Kept server and the bridge.

## Start the bridge

Use Node.js 22.13 or later. From this directory, run `npm ci` and copy `.env.example` to `.env`. Generate a shared key with `openssl rand -hex 24` and set `BRIDGE_TOKEN`. Use `./node_modules/.bin/niimblue-cli scan -t ble` to find the exact printer name, then set `NIIMBOT_ADDRESS`. To use USB serial, scan with `-t serial` and set `NIIMBOT_TRANSPORT=serial` and the serial port instead.

Start the bridge with `npm start`. It listens on loopback by default. If Kept and the bridge run on different hosts, give the Kept server a route to the bridge over a private network or HTTPS. Only the Kept server needs access to that address. Run one bridge process per printer. Jobs live in `data/jobs.sqlite`, so retrying the same job after a lost response does not print it again.

## Connect Kept

Save a server-side file called `label-print.json` with the connection and the rolls you have. Use the same secret in `token` and `BRIDGE_TOKEN`. The IDs in `locations` are the Kept location IDs. The first format is the initial selection. Width is across the printhead and height is in the feed direction.

```json
{
  "url": "https://bridge.example.org",
  "token": "replace-with-your-generated-key",
  "locations": ["a42fb121-67a9-47bf-81a7-fee06306712d"],
  "formats": [
    { "id": "12x30", "widthMm": 12, "heightMm": 30, "dotsPerMm": 8 },
    { "id": "40x30", "widthMm": 40, "heightMm": 30, "dotsPerMm": 8 }
  ]
}
```

Set `KEPT_LABEL_PRINT_CONFIG_FILE` to the path the Kept server can read. In Docker Compose, mount the file read-only into the `kept` service and set the variable to its in-container path in a Compose override. For a private bridge address, set `"allowPrivate": true` in the file. Keep this file outside version control and restrict filesystem access to the user running Kept. Restart Kept after changing the file.

## Print from a phone

Open a thing in Kept and choose **Label → Print → Print on server**. Select the format that matches the loaded roll and check the preview. Press **Print on server** to send one copy. After the printer finishes a one-label batch, verify the sticker and use Kept's confirmation to mark it printed. The bridge supports die-cut rolls with gaps, up to 48 mm across the head at eight dots per millimetre. Keep a recognized RFID tag in the printer. The printer profile uses B1 and density 3.

The bridge API requires `Authorization: Bearer <token>`. `POST /api/kept/v1/jobs` accepts `{id, format, png}` with a 32-character lowercase hex ID, the selected format object and a base64 PNG. Reusing the ID with the same raster returns its existing state. `GET /api/kept/v1/jobs/<id>` returns the job state. Both responses use `{state}` with one of `queued`, `printing`, `done`, `failed` or `uncertain`.

Run `npm test` here to check request authentication, exact raster dimensions and idempotency without a physical print.
