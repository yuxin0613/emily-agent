declare module "node:sqlite" {
  interface StatementSync {
    all(...anonymousParameters: unknown[]): any[];
    get(...anonymousParameters: unknown[]): any;
    run(...anonymousParameters: unknown[]): any;
  }
}
