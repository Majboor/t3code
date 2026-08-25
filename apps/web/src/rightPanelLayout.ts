/**
 * Below this the right panel covers the chat instead of sitting beside it.
 *
 * It was 1180px, which is wider than the window the desktop app opens at, so
 * the desktop never once used the column — the panel always covered the chat
 * and no amount of resizing helped. The column stays usable a long way below
 * that: at 900px it is roughly 470px of workspace against 430px of chat.
 */
export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 899px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME = "w-[min(88vw,820px)] max-w-[820px] p-0";
