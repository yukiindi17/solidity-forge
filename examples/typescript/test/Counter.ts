import { expect } from "chai";
import { ethers } from "hardhat";

describe("Counter", function () {
  it("deploys and executes a transaction on the local EVM", async function () {
    const Counter = await ethers.getContractFactory("Counter");
    const counter = await Counter.deploy();
    await counter.waitForDeployment();
    await (await counter.increment()).wait();
    expect(await counter.value()).to.equal(1n);
  });
});