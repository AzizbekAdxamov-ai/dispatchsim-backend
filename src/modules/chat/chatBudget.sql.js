// One count, scoped to one wallet.
//
// Two queries lived here before, one per chat module, each counting its own
// table against its own cap. Two counts of one key's budget is not a
// budget; it is two budgets that happen to share a bill.
//
// $2 is the wallet scope -- 'both' when the two chats hold the same key,
// otherwise 'broker' or 'driver'. It is a parameter rather than three
// hand-written queries because the three would drift, and the one that
// drifted would be the one nobody was running that week.
//
// Every number the decision needs comes from a single pass:
//
//   used         this dispatcher's turns today, within this wallet
//   account_used every dispatcher's turns today -- the wallet's own total
//   seats        how many people dispatched today, which is what the
//                budget is divided by
//
// role = 'dispatcher' is what makes a row a request. The driver's and the
// broker's own turns are replies to those requests, not requests of their
// own, and counting them would double every number here.
export const DAILY_USAGE_SQL = `
  WITH turns AS (
    SELECT c.user_id
      FROM driver_messages m
      JOIN driver_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'dispatcher'
       AND m.created_at >= date_trunc('day', now())
       AND $2::text IN ('both', 'driver')
    UNION ALL
    SELECT c.user_id
      FROM broker_messages m
      JOIN broker_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'dispatcher'
       AND m.created_at >= date_trunc('day', now())
       AND $2::text IN ('both', 'broker')
  )
  SELECT count(*) FILTER (WHERE user_id = $1)::int AS used,
         count(*)::int                             AS account_used,
         count(DISTINCT user_id)::int              AS seats
    FROM turns`
