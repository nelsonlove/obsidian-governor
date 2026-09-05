// kernel/crosssession — the cross-session channel module's pure core (#232):
// entry parsing/ordering, channel discovery by frontmatter, unread computation,
// and the read-receipt store. See entries.ts / receipts.ts / config.ts.

export {
  ENTRY_SEP,
  isEntryHeadingLine,
  orderKey,
  stripFrontmatter,
  parseLogEntries,
  parseMessageNote,
  sortEntries,
  unreadFor,
  newestStamp,
  channelKey,
  fileClassMatches,
  discoverChannels,
  channelMembers,
  loadChannelEntries,
  type ChannelEntry,
  type Channel,
} from "./entries.js";

export {
  RECEIPTS_FILE,
  ReceiptStore,
  memoryReceiptStore,
  type Receipt,
  type ReceiptsState,
  type ReceiptAdapter,
  type ReceiptStoreLike,
} from "./receipts.js";

export {
  DEFAULT_CROSSSESSION_CONFIG,
  DEFAULT_DELTA_CAP,
  crosssessionConfigOf,
  validateCrosssessionConfig,
  type CrosssessionConfig,
} from "./config.js";
