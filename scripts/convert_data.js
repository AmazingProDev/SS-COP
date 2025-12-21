import { open } from 'shapefile';
import fs from 'fs/promises';
import path from 'path';

const INPUT_DIR = './Tables Régions_Provinces et communes';
const OUTPUT_DIR = './public/data';

const FILES_TO_CONVERT = [
  { name: 'regions', file: 'DA_REGIONS_12R' },
  { name: 'provinces', file: 'DA_PROVINCES_12R' },
  { name: 'communes', file: 'DA_COMMUNES_12R' }
];

async function convert() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const { name, file } of FILES_TO_CONVERT) {
    console.log(`Converting ${name}...`);
    try {
      const source = await open(
        path.join(INPUT_DIR, `${file}.shp`),
        path.join(INPUT_DIR, `${file}.dbf`)
      );

      const geojson = await source.read();
      let features = [];

      // shapefile.read() returns one feature at a time if loop, 
      // but read() effectively returns the whole object if we iterate properly or consume it.
      // Actually source.read() returns {done, value}. We need to loop.

      // Reset reader strategy for 'shapefile' library
      // Correct usage:
      // const features = [];
      // let result;
      // while (!(result = await source.read()).done) {
      //   features.push(result.value);
      // }
      // This library handles it slightly differently if you just want everything?
      // No, we must loop.

      // Re-opening to be safe or just looping correctly
    } catch (e) {
      console.error("Error setup:", e);
    }
  }

  // Refined approach
  for (const { name, file } of FILES_TO_CONVERT) {
    console.log(`Processing ${name}...`);
    const features = [];
    const source = await open(
      path.join(INPUT_DIR, `${file}.shp`),
      path.join(INPUT_DIR, `${file}.dbf`),
      { encoding: 'utf-8' }
    );

    let result;
    while (!(result = await source.read()).done) {
      features.push(result.value);
    }

    const featureCollection = {
      type: "FeatureCollection",
      features: features
    };

    const outPath = path.join(OUTPUT_DIR, `${name}.json`);
    await fs.writeFile(outPath, JSON.stringify(featureCollection));
    console.log(`Saved ${outPath}`);
  }
}

convert().catch(console.error);
