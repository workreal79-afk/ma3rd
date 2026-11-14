export function runInTransaction(db, work) {
  const transaction = db.transaction(work);
  return transaction();
}
