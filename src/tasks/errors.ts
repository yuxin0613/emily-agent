export class IllegalTaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalTaskTransitionError";
  }
}

export class TaskTransitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTransitionConflictError";
  }
}
