# Notification System Design

## Stage 1

The notification platform needs to support four core actions: fetching all notifications for a student, marking a notification as read, deleting a notification, and receiving real-time updates.

### GET /notifications
Fetch all notifications for the logged-in student.

Headers:
```
Authorization: Bearer <token>
```

Response:
```json
{
  "notifications": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "Google is hiring",
      "isRead": false,
      "createdAt": "2026-05-02T10:00:00Z"
    }
  ]
}
```

### PATCH /notifications/:id/read
Mark a specific notification as read.

Response:
```json
{ "message": "updated successfully" }
```

### DELETE /notifications/:id
Delete a notification.

Response:
```json
{ "message": "deleted successfully" }
```

### Real-time Notifications
I'd use WebSockets via Socket.io. When a new notification is created on the server, it emits a `new_notification` event to the student's room. The client listens for this event and updates the UI without polling.

```js
// server side
io.to(`student_${studentId}`).emit('new_notification', notificationData);

// client side
socket.on('new_notification', (data) => {
  updateInbox(data);
});
```

---

## Stage 2

I'd go with PostgreSQL here. The data is structured and relational — students have notifications, notifications have types, read states, timestamps. PostgreSQL handles all of this well with ENUM support, proper indexing, and ACID guarantees.

Schema:

```sql
CREATE TYPE notification_type AS ENUM ('Event', 'Result', 'Placement');

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studentId INT NOT NULL,
  type notification_type NOT NULL,
  message TEXT NOT NULL,
  isRead BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT NOW()
);
```

As data grows, the main problem is the table becoming too large for fast queries. Even with indexes, scanning 50M rows for one student is going to be slow. The fixes I'd apply: composite index on (studentId, isRead), monthly partitioning on createdAt, and archiving notifications older than 6 months to a cold table.

Queries based on Stage 1 APIs:

```sql
-- GET /notifications
SELECT id, type, message, isRead, createdAt
FROM notifications
WHERE studentId = $1
ORDER BY createdAt DESC;

-- PATCH /notifications/:id/read
UPDATE notifications
SET isRead = true
WHERE id = $1;

-- DELETE /notifications/:id
DELETE FROM notifications WHERE id = $1;
```

---

## Stage 3

The query is logically correct — it fetches the right data. But it's slow because there's no index on (studentID, isRead), so Postgres does a full sequential scan across 5 million rows every time.

Also, `SELECT *` is wasteful. We don't need every column, just the ones the frontend actually displays.

The fix is straightforward:

```sql
CREATE INDEX idx_student_read ON notifications(studentID, isRead);
```

This brings the lookup from O(n) down to O(log n). Query time drops significantly.

On the suggestion of adding indexes on every column — that's bad advice. Indexes cost space and slow down writes (INSERT, UPDATE, DELETE all have to update every index). You index the columns you actually filter or sort by, nothing more.

Query to find students who received a placement notification in the last 7 days:

```sql
SELECT DISTINCT studentId
FROM notifications
WHERE type = 'Placement'
AND createdAt >= NOW() - INTERVAL '7 days';
```

---

## Stage 4

The root problem is that we're hitting the database on every page load for every student. At 50,000 students this becomes a serious bottleneck.

**Redis caching** is the most direct fix. Cache each student's notifications with a TTL of around 60 seconds. On new notification, invalidate that student's cache. The tradeoff is that notifications can be up to 60 seconds stale, which is acceptable for most cases but not ideal for placement alerts.

**Cursor-based pagination** helps too. Instead of loading all notifications at once, fetch 20 at a time. This keeps individual queries small. The downside is the client needs to handle pagination logic.

**For real-time specifically** — if we're using WebSockets from Stage 1, we can push new notifications to the client directly instead of relying on page load fetches at all. This is the cleanest long-term solution.

---

## Stage 5

The current implementation has a few obvious problems. It's a sequential loop, so if `send_email` fails at student 200, the remaining 49,800 students never get notified. There's no retry. And mixing DB writes with email sends in the same loop means one slow email API call blocks everything.

DB save and email should not happen together in the same transaction. The DB is the source of truth — save there first, always. Email delivery is a side effect and should be handled async.

My redesign:

```
function notify_all(student_ids, message):
    for student_id in student_ids:
        save_to_db(student_id, message)     # synchronous, must succeed
        enqueue_job(student_id, message)    # push email + push to queue

worker():
    for each job in queue:
        try:
            send_email(job.student_id, job.message)
            push_to_app(job.student_id, job.message)
        except EmailFailure:
            retry(job, max_retries=3, backoff=exponential)
            if still_failed:
                log_failed(job.student_id)
```

This way, DB writes are guaranteed. Email failures are isolated, retried, and logged. The loop doesn't block on slow email APIs.

---

## Stage 6

Priority is determined by two things: notification type weight and recency.

Weights: Placement = 3, Result = 2, Event = 1

Score formula:
```
score = weight * (1 / (minutes_since_creation + 1))
```

Newer notifications score higher within the same type. A recent Event can outscore an old Placement.

To get top N, fetch all notifications, compute scores, sort descending, slice top N.

For maintaining top N efficiently as new notifications come in, I'd use a min-heap of size N. When a new notification arrives, compute its score. If it's higher than the heap's minimum, pop the min and push the new one. This keeps the heap always holding the top N with O(log N) per insertion instead of re-sorting the full list every time.

The code for this is in `notification_app_be/stage6_code.js`.