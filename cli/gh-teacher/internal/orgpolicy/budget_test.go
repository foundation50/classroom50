package orgpolicy

import "testing"

func TestClassifyBudget_Tiers(t *testing.T) {
	actions := func(amount int, prevent bool) Budget {
		return Budget{
			BudgetScope:         BudgetScopeOrg,
			BudgetProductSKU:    BudgetProductSKUActions,
			BudgetAmount:        amount,
			PreventFurtherUsage: prevent,
		}
	}

	cases := []struct {
		name     string
		budgets  []Budget
		wantTier BudgetTier
	}{
		{"no budgets", nil, BudgetMissing},
		{"unrelated sku only", []Budget{{BudgetScope: BudgetScopeOrg, BudgetProductSKU: "packages", BudgetAmount: 0, PreventFurtherUsage: true}}, BudgetMissing},
		{"wrong scope", []Budget{{BudgetScope: "repository", BudgetProductSKU: BudgetProductSKUActions, BudgetAmount: 0, PreventFurtherUsage: true}}, BudgetMissing},
		{"$0 hard-stop is enforced", []Budget{actions(0, true)}, BudgetEnforced},
		{"$0 alert-only is missing (spend not stopped)", []Budget{actions(0, false)}, BudgetMissing},
		{"$1 hard-stop is ok", []Budget{actions(1, true)}, BudgetOK},
		{"$50 hard-stop is ok (boundary)", []Budget{actions(BudgetWarnThreshold, true)}, BudgetOK},
		{"$50 alert-only is missing", []Budget{actions(BudgetWarnThreshold, false)}, BudgetMissing},
		{"$51 hard-stop warns (boundary)", []Budget{actions(BudgetWarnThreshold+1, true)}, BudgetWarn},
		{"$100 alert-only is missing (stops no spend)", []Budget{actions(100, false)}, BudgetMissing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyBudget(tc.budgets)
			if got.Tier != tc.wantTier {
				t.Errorf("ClassifyBudget tier = %q, want %q", got.Tier, tc.wantTier)
			}
		})
	}
}

func TestClassifyBudget_CarriesAmountAndHardStop(t *testing.T) {
	v := ClassifyBudget([]Budget{{
		BudgetScope:         BudgetScopeOrg,
		BudgetProductSKU:    BudgetProductSKUActions,
		BudgetAmount:        75,
		PreventFurtherUsage: true,
	}})
	if v.Tier != BudgetWarn {
		t.Errorf("tier = %q, want warn", v.Tier)
	}
	if v.Amount != 75 {
		t.Errorf("Amount = %d, want 75", v.Amount)
	}
	if !v.PreventsUsage {
		t.Errorf("PreventsUsage = false, want true")
	}
}

func TestClassifyBudget_FirstMatchWins(t *testing.T) {
	// GitHub allows one budget per scope+SKU; classify the org-scoped Actions
	// budget and ignore other scopes/SKUs in the list.
	budgets := []Budget{
		{BudgetScope: "repository", BudgetProductSKU: BudgetProductSKUActions, BudgetAmount: 999, PreventFurtherUsage: true},
		{BudgetScope: BudgetScopeOrg, BudgetProductSKU: "packages", BudgetAmount: 999, PreventFurtherUsage: true},
		{BudgetScope: BudgetScopeOrg, BudgetProductSKU: BudgetProductSKUActions, BudgetAmount: 0, PreventFurtherUsage: true},
	}
	if got := ClassifyBudget(budgets); got.Tier != BudgetEnforced {
		t.Errorf("tier = %q, want enforced (org+actions $0 hard-stop)", got.Tier)
	}
}
