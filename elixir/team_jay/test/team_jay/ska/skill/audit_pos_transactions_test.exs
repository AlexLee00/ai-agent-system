defmodule TeamJay.Ska.Skill.AuditPosTransactionsTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.AuditPosTransactions

  describe "run/2" do
    test "정상 트랜잭션 → passed: true" do
      txs = [
        %{tx_id: "T001", amount: 10000.0, item_count: 2},
        %{tx_id: "T002", amount: 20000.0, item_count: 1}
      ]

      assert {:ok, %{passed: true, issues: [], discrepancy_amount: 0.0}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 30000.0}, %{})
    end

    test "중복 tx_id → 이슈 감지" do
      txs = [
        %{tx_id: "T001", amount: 10000.0, item_count: 1},
        %{tx_id: "T001", amount: 10000.0, item_count: 1}
      ]

      assert {:ok, %{passed: false, issues: [{:duplicate_tx_ids, ["T001"]}]}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 20000.0}, %{})
    end

    test "빈 아이템 트랜잭션 → 이슈 감지" do
      txs = [%{tx_id: "T001", amount: 10000.0, item_count: 0}]

      assert {:ok, %{passed: false, issues: [{:tx_no_items, "T001"}]}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 10000.0}, %{})
    end

    test "100원 이상 금액 불일치 → 이슈 감지" do
      txs = [%{tx_id: "T001", amount: 10000.0, item_count: 1}]

      assert {:ok, %{passed: false, issues: [{:amount_discrepancy, _}]}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 11000.0}, %{})
    end

    test "100원 미만 불일치 → passed: true" do
      txs = [%{tx_id: "T001", amount: 10050.0, item_count: 1}]

      assert {:ok, %{passed: true}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 10000.0}, %{})
    end

    test "빈 트랜잭션 목록 → passed: true" do
      assert {:ok, %{passed: true, issues: []}} =
               AuditPosTransactions.run(%{transactions: [], expected_total: 0.0}, %{})
    end

    test "discrepancy_amount 계산 확인" do
      txs = [%{tx_id: "T001", amount: 5000.0, item_count: 1}]

      assert {:ok, %{discrepancy_amount: -5000.0}} =
               AuditPosTransactions.run(%{transactions: txs, expected_total: 10000.0}, %{})
    end
  end

  describe "metadata/0" do
    test "도메인 :pickko" do
      assert AuditPosTransactions.metadata().domain == :pickko
    end
  end
end
