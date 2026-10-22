ALTER TABLE "email_classifications" DROP CONSTRAINT "email_classifications_decision_source_check";--> statement-breakpoint
ALTER TABLE "email_classifications" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_decision_source_check" CHECK ((
        ("email_classifications"."decision_source" = 'classifier'
          and "email_classifications"."category" is not null
          and "email_classifications"."model" is not null
          and "email_classifications"."prompt_version" is not null
          and "email_classifications"."classifier_version" is not null
          and "email_classifications"."confidence" is not null
          and "email_classifications"."applied_rule_id" is null)
        or ("email_classifications"."decision_source" = 'rule'
          and "email_classifications"."category" is null
          and "email_classifications"."model" is null
          and "email_classifications"."prompt_version" is null
          and "email_classifications"."classifier_version" is null
          and "email_classifications"."confidence" is null
          and "email_classifications"."reasoning_effort" is null
          and "email_classifications"."applied_rule_id" is not null)
        or ("email_classifications"."decision_source" = 'correction'
          and "email_classifications"."category" is null
          and "email_classifications"."model" is null
          and "email_classifications"."prompt_version" is null
          and "email_classifications"."classifier_version" is null
          and "email_classifications"."confidence" is null
          and "email_classifications"."reasoning_effort" is null
          and "email_classifications"."applied_rule_id" is null)
      ));