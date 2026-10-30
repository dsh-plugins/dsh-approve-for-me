/** Old releases own this feature; the official plugin takes over at rc.2. */
export function supportsLegacyApproval(version) {
    if (version === undefined)
        return true; // minimal embedders without loader metadata
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (!match || +match[1] !== 0 || +match[2] !== 1 || +match[3] < 5 || +match[3] > 7)
        return false;
    if (+match[3] < 7)
        return true;
    const [kind, number] = (match[4] ?? '').split('.');
    return kind === 'alpha' || kind === 'beta' || kind === 'rc' && Number(number) < 2;
}
