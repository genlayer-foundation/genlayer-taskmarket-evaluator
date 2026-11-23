A requester selects the evaluator when opening the claim task. For example, with EVALUATOR set to the chosen wallet address:

    taskmarket --network tempo-testnet task create --description "Review a public guide" --mode claim --duration 72 --reward 1 --evaluator "$EVALUATOR" --evaluation-window 24 --appeal-window 1

After submission the evaluator names the worker and award. If a dispute resolver was assigned, the worker can appeal during the appeal window. Otherwise, or if no eligible worker appeals before that window closes, anyone can finalize the verdict. Settlement occurs at finalization.
