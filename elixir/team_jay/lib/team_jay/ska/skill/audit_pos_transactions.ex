defmodule TeamJay.Ska.Skill.AuditPosTransactions do
  @moduledoc """
  피코 POS 트랜잭션 감사 스킬 — Pickko 전용.

  금액 불일치, 중복 결제, 빈 아이템 트랜잭션 검증.

  입력: %{transactions: [...], expected_total: 150000.0}
  출력: {:ok, %{passed: true, issues: [], discrepancy_amount: 0.0}}
  """

  @behaviour TeamJay.Ska.Skill

  @discrepancy_threshold 100.0

  @impl true
  def metadata do
    %{
      name: :audit_pos_transactions,
      domain: :pickko,
      version: "1.0",
      description: "POS 트랜잭션 무결성 감사 (중복/누락/금액 불일치)",
      input_schema: %{transactions: :list, expected_total: :float},
      output_schema: %{passed: :boolean, issues: :list, discrepancy_amount: :float}
    }
  end

  @impl true
  def run(params, _context) do
    transactions = params[:transactions] || []
    expected = params[:expected_total] || 0.0

    issues =
      detect_duplicates(transactions) ++
      detect_missing_items(transactions) ++
      detect_amount_discrepancy(transactions, expected)

    total = Enum.sum(Enum.map(transactions, &(&1[:amount] || 0.0)))
    discrepancy = total - expected

    {:ok, %{
      passed: issues == [],
      issues: issues,
      discrepancy_amount: discrepancy
    }}
  end

  defp detect_duplicates(txs) do
    ids = Enum.map(txs, & &1[:tx_id])
    duplicates = ids -- Enum.uniq(ids)

    if duplicates == [],
      do: [],
      else: [{:duplicate_tx_ids, duplicates}]
  end

  defp detect_missing_items(txs) do
    Enum.flat_map(txs, fn tx ->
      if Map.get(tx, :item_count, 1) == 0,
        do: [{:tx_no_items, tx[:tx_id]}],
        else: []
    end)
  end

  defp detect_amount_discrepancy(txs, expected) do
    total = Enum.sum(Enum.map(txs, &(&1[:amount] || 0.0)))
    diff = abs(total - expected)

    if diff > @discrepancy_threshold,
      do: [{:amount_discrepancy, Float.round(diff, 2)}],
      else: []
  end
end
