import { listRules } from "@/lib/repo/rules";
import { matchRule, type CategorizeInput, type Categorizer } from "./index";

export class RulesCategorizer implements Categorizer {
  private rules?: ReturnType<typeof listRules>;

  async categorize(input: CategorizeInput): Promise<number | null> {
    // Una carga por instancia (una instancia por operación de ingesta/importación).
    this.rules ??= listRules();
    return matchRule(await this.rules, input.merchantNormalized);
  }
}
