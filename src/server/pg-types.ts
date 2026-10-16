import { types } from "pg";
// SQL DATE has no timezone. Both web and PC pools keep its calendar representation.
export const dateOnlyTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 1082 && format !== "binary") return (value: string) => value;
    return types.getTypeParser(oid, format);
  },
};
