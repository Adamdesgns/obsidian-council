import test from "node:test";
import assert from "node:assert/strict";
import {answer} from "./answer.mjs";

test("answer is updated", () => assert.equal(answer, 2));
