import { listRules } from "@/lib/repo/rules";
import { matchRule, type Categorization, type CategorizeInput, type Categorizer } from "./index";

export class RulesCategorizer implements Categorizer {
  private rules?: ReturnType<typeof listRules>;

  async categorizeDetailed(input: CategorizeInput): Promise<Categorization | null> {
    // Una carga por instancia (una instancia por operación de ingesta/importación).
    this.rules ??= listRules();
    const id = matchRule(await this.rules, input.merchantNormalized);
    return id === null ? null : { categoryId: id, source: "rule", confidence: null };
  }

  async categorize(input: CategorizeInput): Promise<number | null> {
    return (await this.categorizeDetailed(input))?.categoryId ?? null;
  }
}
