// Wording for the result of a save on the export screens.

export function savedMessage(count, folder) {
  if (!String(folder).startsWith('Pictures/')) return 'Saved to your Downloads, in the RedactID folder.';
  const what = count === 1 ? 'Saved' : `Saved ${count} photos`;
  return `${what} to your gallery, in the RedactID album.`;
}

// True when the user simply closed the share sheet.
export function isCancelError(err) {
  return err?.name === 'AbortError' || /cancel/i.test(String(err?.message || ''));
}
