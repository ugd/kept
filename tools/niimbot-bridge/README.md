# Printing Kept labels on a NIIMBOT B21S-C2B

Run the bridge on the computer that can reach the printer. Kept renders the label at the chosen roll size and sends a PNG to the bridge. The 50 × 30 mm and 40 × 40 mm formats put the QR on the left and the short ID, name and location on the right. A phone needs only its ordinary Kept session. The connection key stays on the Kept server and the bridge.

## Start the bridge

Use Node.js 22.13 or later. From this directory, run `npm ci` and copy `.env.example` to `.env`. Generate a shared key with `openssl rand -hex 24` and set `BRIDGE_TOKEN`. Use `./node_modules/.bin/niimblue-cli scan -t ble` to find the exact printer name, then set `NIIMBOT_ADDRESS`. To use USB serial, scan with `-t serial` and set `NIIMBOT_TRANSPORT=serial` and the serial port instead.

Start the bridge with `npm start`. It listens on loopback by default. If Kept and the bridge run on different hosts, give the Kept server a route to the bridge over a private network or HTTPS. Only the Kept server needs access to that address. Run one bridge process per printer. Jobs live in `data/jobs.sqlite`, so retrying the same job after a lost response does not print it again.

## Connect Kept

Open **Settings → Locations → your location → Print server** as an owner or admin with Labels enabled. Enter the bridge's base URL and paste the same key as `BRIDGE_TOKEN`. Kept must be able to reach that URL from its server. For a LAN or VPN address, the instance admin can enable private addresses in **Admin → Settings**. Use HTTPS for a public address. Plain HTTP is available with private addresses enabled and a private destination.

For a **50 × 30 mm** NIIMBOT roll, enter a width of **50**, height of **30**, printable width of **48**, and resolution of **8 dots/mm**. This makes a 384 × 240 dot raster. For a **40 × 40 mm** roll, add a format with width **40**, height **40**, printable width **40**, and resolution **8 dots/mm**. This makes a 320 × 320 dot raster. Width is across the printhead and height is in the feed direction. Select **Save**, then **Test connection**. The test checks the bridge and key without submitting a job. The print picker starts with the format that matches the batch’s stock when available.

### File-based configuration

For a file-managed Kept installation, save a server-side `label-print.json` with the connection and your rolls. A connection saved in the location UI takes precedence. Disconnecting it in the UI returns the location to the file configuration when one exists. Use the same secret in `token` and `BRIDGE_TOKEN`. The IDs in `locations` are the Kept location IDs.

```json
{
  "url": "https://bridge.example.org",
  "token": "replace-with-your-generated-key",
  "locations": ["a42fb121-67a9-47bf-81a7-fee06306712d"],
  "formats": [
    { "id": "50x30", "widthMm": 50, "printableWidthMm": 48, "heightMm": 30, "dotsPerMm": 8 },
    { "id": "12x30", "widthMm": 12, "heightMm": 30, "dotsPerMm": 8 },
    { "id": "40x40", "widthMm": 40, "heightMm": 40, "dotsPerMm": 8 }
  ]
}
```

Set `KEPT_LABEL_PRINT_CONFIG_FILE` to the path the Kept server can read. In Docker Compose, mount the file read-only into the `kept` service and set the variable to its in-container path in a Compose override. For a private bridge address, set `"allowPrivate": true` in the file. Keep this file outside version control and restrict filesystem access to the user running Kept. Restart Kept after changing the file.

## Print from a phone

Open a thing in Kept and choose **Label → Print → Print on server**. Select the format that matches the loaded roll and check the preview. Press **Print on server** to send one copy. After the printer finishes a one-label batch, verify the sticker and use Kept's confirmation to mark it printed. The bridge supports die-cut rolls with gaps, a physical width up to 50 mm and a printable width up to 48 mm at eight dots per millimetre. Keep a recognized RFID tag in the printer. The printer profile uses B1 and density 3. [B21S-C2B specifications](https://printers.niim.blue/hardware/models/)

The bridge API requires `Authorization: Bearer <token>`. `GET /api/kept/v1/health` returns `{ok: true}` when the token is accepted. `POST /api/kept/v1/jobs` accepts `{id, format, png}` with a 32-character lowercase hex ID, the selected format object and a base64 PNG. Reusing the ID with the same raster returns its existing state. `GET /api/kept/v1/jobs/<id>` returns the job state. Both job responses use `{state}` with one of `queued`, `printing`, `done`, `failed` or `uncertain`.

Run `npm test` here to check request authentication, exact raster dimensions and idempotency without a physical print.
