
import { Template, defaultBuildLogger } from 'e2b'
import { template as nextJSTemplate } from './template'
import dotenv from 'dotenv'
dotenv.config()


Template.build(nextJSTemplate , "c0-build" , {
    cpuCount: 4,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger(),
    apiKey:"e2b_6e20ebf3abb201214e1978db60b1b1e93e2a47bf"
})