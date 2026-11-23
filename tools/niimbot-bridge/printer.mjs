import sharp from 'sharp';

export function makePrinter({ transport, address }) {
  return async function printLabel(png) {
    const {
      default: { initClient, printImages },
    } = await import('@mmote/niimblue-node/dist/utils.js');
    const {
      default: { ImageEncoder },
    } = await import('@mmote/niimblue-node');
    const {
      default: { LabelType, PageColorType },
    } = await import('@mmote/niimbluelib');
    const client = initClient(transport, address, false);
    if (transport === 'ble') {
      const discover = client.getDevice.bind(client);
      client.getDevice = (name) => discover(name, 18_000);
    }

    try {
      await client.connect();
      if (client.getPrinterInfo().modelId !== 776)
        throw new Error('Expected NIIMBOT B21S-C2B (776)');
      const { paperInserted, lidClosed, paperRfidSuccess } = await client.fetchHeartbeatData();
      if (!paperInserted || !lidClosed || !paperRfidSuccess) {
        throw new Error('Printer needs paper, a closed lid and an accepted RFID tag');
      }
      const encoded = await ImageEncoder.encodeImage(sharp(png), PageColorType.SingleColor, 'top');
      try {
        await printImages(client, 'B1', [{ encoded }], {
          quantity: 1,
          density: 3,
          labelType: LabelType.WithGaps,
        });
      } catch (cause) {
        const error = new Error('Physical print result is uncertain', { cause });
        error.uncertain = true;
        throw error;
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
  };
}
