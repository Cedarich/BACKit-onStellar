export enum NotificationType {
  BACKED_CALL = 'BACKED_CALL',
  CALL_ENDED = 'CALL_ENDED',
  PAYOUT_READY = 'PAYOUT_READY',
  NEW_FOLLOWER = 'NEW_FOLLOWER',
  CALL_RESOLVED = 'CALL_RESOLVED',
  STAKE_UPDATE = 'STAKE_UPDATE',
  /** A call/market the user staked on is about to close (#375). */
  CALL_CLOSING = 'CALL_CLOSING',
  PRICE_ALERT_TRIGGERED = 'PRICE_ALERT_TRIGGERED',
  /** A Soroban transaction the user submitted failed on-chain (BE-004). */
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
}
