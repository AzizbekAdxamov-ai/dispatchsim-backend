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
// role = 'dispatcher' is what makes a row a turn. The driver's and the
// broker's own turns are replies to those turns, not turns of their own,
// and counting them would double every number here.
//
// A turn is not one request (055). Its reply can cost a second try when the
// model ran out of room, a regeneration when the reply was unusable, and a
// backoff retry inside either. Counting rows charged one for all of that,
// and the 10% headroom was the only thing between the count and the
// provider's wall. Each dispatcher row now carries the requests its reply
// actually cost, and the budget is their sum.
//
//   script_used the part of account_used that the evaluation and scenario
//              scripts spent (058). They write no threads, so before 058
//              the budget could not see them. Their rows have no user: they
//              add to the wallet's total, never to anyone's share or seat.
//
//   my_turns   whether this dispatcher has a seat yet -- by turns, not by
//              requests, because a turn that cost nothing still sat down
export const DAILY_USAGE_SQL = `
  WITH turns AS (
    SELECT c.user_id, m.provider_requests AS n, false AS script
      FROM driver_messages m
      JOIN driver_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'dispatcher'
       AND m.created_at >= date_trunc('day', now())
       AND $2::text IN ('both', 'driver')
    UNION ALL
    SELECT c.user_id, m.provider_requests, false
      FROM broker_messages m
      JOIN broker_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'dispatcher'
       AND m.created_at >= date_trunc('day', now())
       AND $2::text IN ('both', 'broker')
    UNION ALL
    SELECT NULL::uuid, s.requests, true
      FROM chat_script_requests s
     WHERE s.created_at >= date_trunc('day', now())
       AND $2::text IN ('both', s.side)
  )
  SELECT coalesce(sum(n) FILTER (WHERE user_id = $1), 0)::int AS used,
         coalesce(sum(n), 0)::int                           AS account_used,
         coalesce(sum(n) FILTER (WHERE script), 0)::int     AS script_used,
         count(*) FILTER (WHERE user_id = $1)::int           AS my_turns,
         count(DISTINCT user_id)::int                       AS seats
    FROM turns`
