type PlanChild = { status: string; outcome: string | null; prUrl: string | null };

/** Done, or finished in Review without a PR to merge (same rule as the server's plan.ts). */
export const complete = (t: PlanChild) => t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);

/** The plan has at least one child and every child is done: the planner's next step is Move to Done. */
export const planFinished = (children: PlanChild[]) => children.length > 0 && children.every(complete);

/** The plan's wake-up count in plain words: "Claude checked in 3 times". */
export const checkInsText = (n: number) => `Claude checked in ${n === 1 ? "once" : `${n} times`}`;
