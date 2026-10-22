ALTER TABLE "email_classifications" DROP CONSTRAINT "email_classifications_applied_rule_id_mail_rules_id_fk";
--> statement-breakpoint
ALTER TABLE "email_classifications" ADD CONSTRAINT "email_classifications_applied_rule_id_mail_rules_id_fk" FOREIGN KEY ("applied_rule_id") REFERENCES "public"."mail_rules"("id") ON DELETE restrict ON UPDATE no action;