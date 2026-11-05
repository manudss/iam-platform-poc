// Spike: compare two Cedar policy sets with SymCC + cvc5 (optimized compiler path).
// Usage: spike-cedar-symcc <schema.cedarschema> <a.cedar> <b.cedar> [--cex]
// Prints the relation between set A and set B over every request environment:
// EQUIVALENT | A_NARROWER (B allows strictly more) | A_WIDER | INCOMPARABLE.
use cedar_policy::{PolicySet, Schema, ValidationMode, Validator};
use cedar_policy_symcc::{
    solver::LocalSolver, CedarSymCompiler, CompiledPolicySet, CompiledSchema,
};
use std::str::FromStr;
use std::time::Instant;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: {} <schema> <a.cedar> <b.cedar> [--cex]", args[0]);
        std::process::exit(2);
    }
    let want_cex = args.iter().any(|a| a == "--cex");
    let schema_text = std::fs::read_to_string(&args[1]).unwrap();
    let a_text = std::fs::read_to_string(&args[2]).unwrap();
    let b_text = std::fs::read_to_string(&args[3]).unwrap();

    let t0 = Instant::now();
    let schema = Schema::from_cedarschema_str(&schema_text).unwrap().0;
    let a = PolicySet::from_str(&a_text).unwrap();
    let b = PolicySet::from_str(&b_text).unwrap();
    println!("parse: {:?}", t0.elapsed());

    // Step 1: plain schema validation (cedar-policy only, no solver) - the "step 2" gate.
    let validator = Validator::new(schema.clone());
    for (name, pset) in [("A", &a), ("B", &b)] {
        let res = validator.validate(pset, ValidationMode::Strict);
        println!(
            "validate {}: {} error(s)",
            name,
            res.validation_errors().count()
        );
        for e in res.validation_errors() {
            println!("  validation error: {}", e);
        }
    }

    let t1 = Instant::now();
    let cvc5 = LocalSolver::cvc5().expect("cvc5 not found (set CVC5=/path/to/cvc5)");
    let mut compiler = CedarSymCompiler::new(cvc5).unwrap();
    let compiled_schema = CompiledSchema::new(&schema).unwrap();
    println!("solver + schema init: {:?}", t1.elapsed());

    let mut a_implies_b = true;
    let mut b_implies_a = true;
    let mut first_cex_ab = None;
    let mut first_cex_ba = None;
    for req_env in schema.request_envs() {
        let t = Instant::now();
        let sym_env = compiled_schema.sym_env(&req_env).unwrap();
        let ca = CompiledPolicySet::compile_with_custom_symenv(&a, &req_env, &schema, sym_env.clone())
            .unwrap();
        let cb = CompiledPolicySet::compile_with_custom_symenv(&b, &req_env, &schema, sym_env)
            .unwrap();
        let t_compile = t.elapsed();
        let t = Instant::now();
        let ab = compiler.check_implies_opt(&ca, &cb).await.unwrap();
        let t_ab = t.elapsed();
        let t = Instant::now();
        let ba = compiler.check_implies_opt(&cb, &ca).await.unwrap();
        let t_ba = t.elapsed();
        println!(
            "env {}: compile {:?}  A=>B {} ({:?})  B=>A {} ({:?})",
            req_env.action(),
            t_compile,
            ab,
            t_ab,
            ba,
            t_ba
        );
        a_implies_b &= ab;
        b_implies_a &= ba;
        if want_cex && !ab && first_cex_ab.is_none() {
            first_cex_ab = compiler
                .check_implies_with_counterexample_opt(&ca, &cb)
                .await
                .unwrap();
        }
        if want_cex && !ba && first_cex_ba.is_none() {
            first_cex_ba = compiler
                .check_implies_with_counterexample_opt(&cb, &ca)
                .await
                .unwrap();
        }
    }
    let relation = match (a_implies_b, b_implies_a) {
        (true, true) => "EQUIVALENT",
        (true, false) => "A_NARROWER (B allows strictly more)",
        (false, true) => "A_WIDER (A allows strictly more)",
        (false, false) => "INCOMPARABLE (each allows something the other forbids)",
    };
    println!("RELATION: {}", relation);
    if let Some(cex) = first_cex_ab {
        println!("counterexample (allowed by A, denied by B): request = {:?}", cex.request);
    }
    if let Some(cex) = first_cex_ba {
        println!("counterexample (allowed by B, denied by A): request = {:?}", cex.request);
    }
    println!("total: {:?}", t0.elapsed());
}
