const MEETING_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

export function isMeetCallUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname === 'meet.google.com' && MEETING_CODE.test(pathname);
  } catch {
    return false;
  }
}

export function meetCode(url) {
  try {
    return new URL(url).pathname.match(MEETING_CODE)?.[0] || '';
  } catch {
    return '';
  }
}

/** Best human-readable meeting name from the Meet page, the tab title, or the meeting code. */
export function meetingTitle(pageTitle, tabTitle, url) {
  const code = meetCode(url);
  const fromTab = (tabTitle || '').replace(/^\s*(google\s+)?meet\s*[-–—:|]\s*/i, '');
  for (const candidate of [pageTitle, fromTab]) {
    const title = (candidate || '').trim();
    if (title && title !== code && !/^(google\s+)?meet$/i.test(title)) return title;
  }
  return code ? `Meeting ${code}` : 'Google Meet call';
}
