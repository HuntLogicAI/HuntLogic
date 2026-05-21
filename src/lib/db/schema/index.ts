// ========================
// Schema barrel export
// ========================

// Users domain
export {
  users,
  hunterPreferences,
  pointHoldings,
  applicationHistory,
  harvestHistory,
  usersRelations,
  hunterPreferencesRelations,
  pointHoldingsRelations,
  applicationHistoryRelations,
  harvestHistoryRelations,
} from "./users";

// Hunting data domain
export {
  states,
  species,
  stateSpecies,
  huntUnits,
  statesRelations,
  speciesRelations,
  stateSpeciesRelations,
  huntUnitsRelations,
} from "./hunting";

// Intelligence domain
export {
  drawOdds,
  harvestStats,
  seasons,
  deadlines,
  drawOddsRelations,
  harvestStatsRelations,
  seasonsRelations,
  deadlinesRelations,
} from "./intelligence";

// Recommendations domain
export {
  playbooks,
  recommendations,
  playbooksRelations,
  recommendationsRelations,
} from "./recommendations";

// Actions domain
export {
  userActions,
  userActionsRelations,
} from "./actions";

// Notifications domain
export {
  notifications,
  notificationPreferences,
  notificationsRelations,
  notificationPreferencesRelations,
} from "./notifications";

// Push subscriptions (VAPID web push)
export {
  pushSubscriptions,
  pushSubscriptionsRelations,
} from "./push-subscriptions";

// Data sources domain
export {
  dataSources,
  documents,
  dataSourcesRelations,
  documentsRelations,
} from "./data-sources";

// Config domain
export {
  aiPrompts,
  appConfig,
} from "./config";

// Regulations domain
export {
  stateRegulations,
  stateRegulationsRelations,
} from "./regulations";

// Outfitters domain
export {
  outfitters,
  outfitterReviews,
  outfittersRelations,
  outfitterReviewsRelations,
} from "./outfitters";

// Groups domain
export {
  huntGroups,
  huntGroupMembers,
  huntGroupPlans,
  huntGroupsRelations,
  huntGroupMembersRelations,
  huntGroupPlansRelations,
} from "./groups";

// Credentials domain
export {
  stateCredentials,
  stateCredentialsRelations,
} from "./credentials";

// Auth domain
export {
  authAccounts,
  verificationTokens,
  authAccountsRelations,
} from "./auth";

// AI Chat domain
export {
  aiChatSessions,
  aiChatMessages,
  aiChatSessionsRelations,
  aiChatMessagesRelations,
} from "./ai-chat";

// Knowledge domain
export { knowledgeChunks } from "./knowledge-chunks";

// Concierge domain
export {
  stateFeeSchedules,
  serviceFeeConfig,
  applicationOrders,
  applicationOrderItems,
  payments,
  refunds,
  stateFormConfigs,
  fulfillmentLogs,
  opsUsers,
  stateFeeSchedulesRelations,
  applicationOrdersRelations,
  applicationOrderItemsRelations,
  paymentsRelations,
  refundsRelations,
  stateFormConfigsRelations,
  fulfillmentLogsRelations,
  opsUsersRelations,
} from "./concierge";
