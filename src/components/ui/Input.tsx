import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn(
        // h-9 (36px) is the canonical input height — matches Button size="lg"
        // so Input + Button rows (Browse, Add, etc.) line up at the same
        // baseline. Without an explicit height the input was ~36px from
        // `py-2`, but Button default md is 32px → 4px misalignment.
        "ui-sunk-input h-9 w-full rounded-[7px] px-3 text-[13px] outline-none",
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = "Input";
