// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Counter} from "../src/Counter.sol";

contract CounterTest {
    Counter private counter;
    function setUp() public { counter = new Counter(); }
    function testIncrement() public {
        counter.increment();
        require(counter.value() == 1, "counter should increment");
    }
    function testFuzzSet(uint256 value) public {
        counter.set(value);
        require(counter.value() == value, "stored value mismatch");
    }
}