// Research work units count coefficient applications, bound endpoint operations
// and candidate comparisons. They are not CPU cycles; elapsed time is measured too.
export class WorkBudget {
  used = 0;
  limit;
  constructor(limit = 1_000_000) {
    this.extend(limit);
  }
  extend(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit < (this.limit ?? 0))
      throw Error('Invalid work budget');
    this.limit = limit;
  }
  take = (units) => {
    if (!Number.isSafeInteger(units) || units < 0) throw Error('Invalid work charge');
    if (this.used + units > this.limit) {
      const e = new Error('Numeric work budget exhausted');
      e.code = 'BUDGET_EXHAUSTED';
      throw e;
    }
    this.used += units;
  };
}
