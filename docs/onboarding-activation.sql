WITH activity AS (
    SELECT person_id, event, timestamp
    FROM events
    WHERE timestamp >= now() - INTERVAL 30 DAY
      AND properties.environment = 'production'
      AND event IN ('verification_approved', 'member_contributed', 'member_received_reply')
),
approvals AS (
    SELECT person_id, min(timestamp) AS approved_at
    FROM activity
    WHERE event = 'verification_approved'
    GROUP BY person_id
    HAVING approved_at <= now() - INTERVAL 7 DAY
),
members AS (
    SELECT
        a.person_id,
        minIf(e.timestamp, e.event = 'member_contributed' AND e.timestamp >= a.approved_at AND e.timestamp < a.approved_at + INTERVAL 7 DAY) AS first_contribution,
        maxIf(e.timestamp, e.event = 'member_contributed' AND e.timestamp >= a.approved_at AND e.timestamp < a.approved_at + INTERVAL 7 DAY) AS last_contribution,
        maxIf(e.timestamp, e.event = 'member_received_reply' AND e.timestamp >= a.approved_at AND e.timestamp < a.approved_at + INTERVAL 7 DAY) AS last_reply,
        countIf(e.event = 'member_contributed' AND e.timestamp >= a.approved_at AND e.timestamp < a.approved_at + INTERVAL 7 DAY) AS contribution_count,
        countIf(e.event = 'member_received_reply' AND e.timestamp >= a.approved_at AND e.timestamp < a.approved_at + INTERVAL 7 DAY) AS reply_count
    FROM approvals a
    LEFT JOIN activity e ON a.person_id = e.person_id
    GROUP BY a.person_id
)
SELECT
    count() AS mature_approved_members,
    countIf(contribution_count > 0 AND reply_count > 0 AND last_reply >= first_contribution AND toDate(last_contribution) > toDate(first_contribution)) AS activated_members,
    if(count() = 0, NULL, activated_members / count()) AS activation_rate
FROM members
