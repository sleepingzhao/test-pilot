/** Path-level URL match: `/api/users` does not match `/api/users/export`. */
export function urlPathMatches(url: string, urlIncludes: string): boolean {
  try {
    let patternPath = urlIncludes;
    if (urlIncludes.includes("://")) {
      patternPath = new URL(urlIncludes).pathname;
    } else if (!patternPath.startsWith("/")) {
      patternPath = `/${patternPath}`;
    }
    const pathname = new URL(url).pathname;
    if (patternPath.endsWith("/")) {
      return pathname === patternPath.slice(0, -1) || pathname.startsWith(patternPath);
    }
    return pathname === patternPath;
  } catch {
    return url.includes(urlIncludes);
  }
}
