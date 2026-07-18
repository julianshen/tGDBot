export interface ReviewTarget {
  readonly provider: "github";
  readonly host: "github.com";
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly canonicalUrl: string;
}
