/**
 * Lightweight EXIF parser — reads GPS, camera, datetime from JPEG files.
 * Only parses what we need for the "what was stripped" summary.
 */

const EXIF_TAGS = {
  0x010F: 'make',
  0x0110: 'model',
  0x0112: 'orientation',
  0x0131: 'software',
  0x0132: 'dateTime',
  0x9003: 'dateTimeOriginal',
  0x9004: 'dateTimeDigitized',
  0x920A: 'focalLength',
  0xA434: 'lensModel',
};

const GPS_TAGS = {
  0x0001: 'latRef',
  0x0002: 'lat',
  0x0003: 'lngRef',
  0x0004: 'lng',
  0x0005: 'altRef',
  0x0006: 'alt',
};

function readUint16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

function readUint32(view, offset, littleEndian) {
  return view.getUint32(offset, littleEndian);
}

function readString(view, offset, length) {
  let str = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    str += String.fromCharCode(c);
  }
  return str.trim();
}

function readRational(view, offset, littleEndian) {
  const num = readUint32(view, offset, littleEndian);
  const den = readUint32(view, offset + 4, littleEndian);
  return den === 0 ? 0 : num / den;
}

function readIFD(view, tiffStart, ifdOffset, littleEndian, tagMap) {
  const result = {};
  try {
    const entries = readUint16(view, tiffStart + ifdOffset, littleEndian);
    for (let i = 0; i < entries; i++) {
      const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > view.byteLength) break;

      const tag = readUint16(view, entryOffset, littleEndian);
      const type = readUint16(view, entryOffset + 2, littleEndian);
      const count = readUint32(view, entryOffset + 4, littleEndian);
      const valueOffset = entryOffset + 8;

      const tagName = tagMap[tag];
      if (!tagName) continue;

      // Type: 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL
      if (type === 2) {
        // ASCII string
        const strLen = count;
        if (strLen <= 4) {
          result[tagName] = readString(view, valueOffset, strLen);
        } else {
          const ptr = readUint32(view, valueOffset, littleEndian);
          result[tagName] = readString(view, tiffStart + ptr, strLen);
        }
      } else if (type === 3) {
        result[tagName] = readUint16(view, valueOffset, littleEndian);
      } else if (type === 4) {
        result[tagName] = readUint32(view, valueOffset, littleEndian);
      } else if (type === 5) {
        // RATIONAL — value is pointer to num/den pair(s)
        const ptr = readUint32(view, valueOffset, littleEndian);
        if (count === 1) {
          result[tagName] = readRational(view, tiffStart + ptr, littleEndian);
        } else {
          const vals = [];
          for (let j = 0; j < count; j++) {
            vals.push(readRational(view, tiffStart + ptr + j * 8, littleEndian));
          }
          result[tagName] = vals;
        }
      }
    }
    // Return next IFD offset
    const nextOffset = readUint32(view, tiffStart + ifdOffset + 2 + entries * 12, littleEndian);
    result._nextIFD = nextOffset;
  } catch {
    // Graceful degradation on corrupt EXIF
  }
  return result;
}

function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  let decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
  if (ref === 'S' || ref === 'W') decimal = -decimal;
  return Math.round(decimal * 1000000) / 1000000;
}

/**
 * Extract EXIF metadata from a File or ArrayBuffer.
 * Returns structured metadata object or null if no EXIF found.
 */
export async function extractMetadata(file) {
  const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const view = new DataView(buffer);

  // Check for JPEG SOI marker
  if (view.byteLength < 4) return null;
  if (view.getUint16(0) !== 0xFFD8) {
    // Not a JPEG — check for PNG
    if (view.getUint32(0) === 0x89504E47) {
      return { format: 'PNG', note: 'PNG files may contain tEXt metadata chunks — stripped on re-encode' };
    }
    return { format: 'Unknown' };
  }

  // Find APP1 (EXIF) marker
  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) break; // APP1
    if ((marker & 0xFF00) !== 0xFF00) return { format: 'JPEG', note: 'No EXIF data found' };
    const segLen = view.getUint16(offset + 2);
    offset += 2 + segLen;
  }

  if (offset >= view.byteLength - 4) {
    return { format: 'JPEG', note: 'No EXIF data found' };
  }

  // APP1 found
  const app1Length = view.getUint16(offset + 2);
  const exifStart = offset + 4;

  // Check "Exif\0\0"
  if (readString(view, exifStart, 4) !== 'Exif') {
    return { format: 'JPEG', note: 'APP1 marker found but not EXIF' };
  }

  const tiffStart = exifStart + 6;
  const byteOrder = view.getUint16(tiffStart);
  const littleEndian = byteOrder === 0x4949; // 'II' = Intel = little-endian

  // Verify TIFF magic
  if (readUint16(view, tiffStart + 2, littleEndian) !== 0x002A) {
    return { format: 'JPEG', note: 'Invalid TIFF header' };
  }

  const ifd0Offset = readUint32(view, tiffStart + 4, littleEndian);

  // Read IFD0
  const ifd0 = readIFD(view, tiffStart, ifd0Offset, littleEndian, EXIF_TAGS);

  // Look for SubIFD (EXIF IFD pointer at tag 0x8769)
  let exifIFD = {};
  try {
    const entries = readUint16(view, tiffStart + ifd0Offset, littleEndian);
    for (let i = 0; i < entries; i++) {
      const entryOffset = tiffStart + ifd0Offset + 2 + i * 12;
      const tag = readUint16(view, entryOffset, littleEndian);
      if (tag === 0x8769) {
        const subOffset = readUint32(view, entryOffset + 8, littleEndian);
        exifIFD = readIFD(view, tiffStart, subOffset, littleEndian, EXIF_TAGS);
        break;
      }
    }
  } catch { /* ignore */ }

  // Look for GPS IFD (pointer at tag 0x8825)
  let gpsIFD = {};
  try {
    const entries = readUint16(view, tiffStart + ifd0Offset, littleEndian);
    for (let i = 0; i < entries; i++) {
      const entryOffset = tiffStart + ifd0Offset + 2 + i * 12;
      const tag = readUint16(view, entryOffset, littleEndian);
      if (tag === 0x8825) {
        const gpsOffset = readUint32(view, entryOffset + 8, littleEndian);
        gpsIFD = readIFD(view, tiffStart, gpsOffset, littleEndian, GPS_TAGS);
        break;
      }
    }
  } catch { /* ignore */ }

  // Build result
  const result = {
    format: 'JPEG',
    camera: [ifd0.make, ifd0.model].filter(Boolean).join(' ') || null,
    software: ifd0.software || null,
    dateTime: exifIFD.dateTimeOriginal || exifIFD.dateTimeDigitized || ifd0.dateTime || null,
    orientation: ifd0.orientation || null,
    focalLength: exifIFD.focalLength ? `${exifIFD.focalLength}mm` : null,
    lens: exifIFD.lensModel || null,
    gps: null,
  };

  if (gpsIFD.lat && gpsIFD.lng) {
    const lat = dmsToDecimal(gpsIFD.lat, gpsIFD.latRef);
    const lng = dmsToDecimal(gpsIFD.lng, gpsIFD.lngRef);
    if (lat !== null && lng !== null) {
      result.gps = { lat, lng };
      if (gpsIFD.alt != null) {
        result.gps.alt = Math.round(gpsIFD.alt * 10) / 10;
      }
    }
  }

  // Count total fields that had data
  result.fieldsStripped = Object.values(result).filter(v => v !== null && v !== 'JPEG').length;

  return result;
}
