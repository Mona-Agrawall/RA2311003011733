# Stage 1

## REST API Design

### GET /notifications
Returns all notifications for logged-in student.
**Headers:** `Authorization: Bearer <token>`
**Response:**
```json
{ "notifications": [{ "id": "uuid", "type": "Placement|Result|Event", "message": "string", "isRead": false, "createdAt": "timestamp" }] }
```

### PATCH /notifications/:id/read
Marks a notification as read.
**Response:** `{ "message": "updated successfully" }`

### DELETE /notifications/:id
Deletes a notification.
**Response:** `{ "message": "deleted successfully" }`

### Real-time: Use WebSockets (Socket.io). Server emits `new_notification` event to student's room on new notification creation.

---

# Stage 2

**DB Choice: PostgreSQL**
Reason: Structured data, supports indexes, ENUM types, ACID compliance.

**Schema:**
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

**Scale problems:** Table grows to millions of rows → slow full scans.
**Solutions:** Index on (studentId, isRead), partition by createdAt (monthly), archive old data.

**Queries:**
```sql
-- Get unread notifications
SELECT * FROM notifications WHERE studentId = $1 AND isRead = false ORDER BY createdAt DESC;

-- Mark as read
UPDATE notifications SET isRead = true WHERE id = $1;
```

---

# Stage 3

**Is the query accurate?**
`SELECT * FROM notifications WHERE studentID = 1042 AND isRead = false ORDER BY createdAt DESC`
Logically correct but slow — no index on (studentID, isRead).

**Why slow:** Full table scan on 5M rows. SELECT * fetches all columns unnecessarily.

**Fix:**
```sql
CREATE INDEX idx_student_read ON notifications(studentID, isRead);
```
Cost drops from O(n) full scan to O(log n) index lookup.

**Adding indexes on every column:** BAD. Slows down INSERT/UPDATE/DELETE. Wastes disk. Only index what you query on.

**Placements in last 7 days:**
```sql
SELECT * FROM notifications
WHERE notificationType = 'Placement'
AND createdAt >= NOW() - INTERVAL '7 days';
```

---

# Stage 4

**Problem:** DB hit on every page load for every student = thundering herd.

**Solutions:**
1. **Redis cache** — cache notifications per studentId with TTL 60s. Invalidate on new notification. Tradeoff: slight staleness.
2. **Pagination** — cursor-based, fetch 20 at a time. Tradeoff: more client requests but smaller DB load per request.
3. **CDN/Edge caching** — for static notification templates. Tradeoff: not personalized.

---

# Stage 5

**Problems with current implementation:**
- Sequential loop — if send_email fails at student 200, remaining 49,800 don't get notified
- No retry mechanism
- Email + DB in same loop = slow, blocking

**Should DB save and email happen together?** No. Decouple them. Save to DB first (source of truth), then emit email async via queue.

**Revised pseudocode:**
function notify_all(student_ids, message):
enqueue_batch(student_ids, message)  # push to message queue
worker():
for each job in queue:
save_to_db(job.student_id, job.message)
try:
send_email(job.student_id, job.message)
push_to_app(job.student_id, job.message)
except EmailFailure:
retry(job, max_retries=3)
if still_failed: log_failed(job.student_id)

---

# Stage 6

**Approach:** Score each notification = weight × recency_factor
- Placement = 3, Result = 2, Event = 1
- recency_factor = 1 / (minutes_ago + 1)

Sort descending by score, take top N.

**Maintaining top-N efficiently for new notifications:**
Use a min-heap of size N. On new notification: compute score, if score > heap.min → pop min, push new. O(log N) per insertion.