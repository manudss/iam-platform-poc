;; Blocking plugin example: deny sensitive access outside 08:00-19:59 (hour in 0..23).
(module
  (func (export "decide") (param $hour i32) (param $sensitive i32) (result i32)
    (if (result i32) (i32.eqz (local.get $sensitive))
      (then (i32.const 0))
      (else
        (if (result i32)
          (i32.or (i32.lt_s (local.get $hour) (i32.const 8))
                  (i32.ge_s (local.get $hour) (i32.const 20)))
          (then (i32.const 1))
          (else (i32.const 0)))))))
